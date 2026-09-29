/* /api/research — AI-supervised deep creator research, with no paid scraper.

   Two kinds of caller share this one route (Vercel Hobby caps the number of
   functions, so it is op-routed):

   BROWSER (behind the usual access-code gate)
     POST ?op=create   {brief}          → queue a research job
     GET  ?op=jobs                       → the last 30 jobs, summaries only
     GET  ?op=job&id=                    → one job: status, progress, log
     GET  ?op=results&id=&offset=&limit= → accepted creators, paged
     POST ?op=cancel   {id}              → ask the worker to stop
     POST ?op=resume   {id}              → requeue a stopped/finished job to keep going

   WORKER (harvest/research-worker.mjs on GitHub Actions; header
   x-worker-secret = FREE_HARVEST_SECRET — never a URL parameter)
     POST ?op=peek                       → is there anything to do?
     POST ?op=claim    {runner}          → lease the next job + its checkpoint
     POST ?op=save     {id,patch,ckpt,log}→ progress, checkpoint, lease renewal
     POST ?op=add      {id,creators}     → append accepted creators
     POST ?op=ai       {payload}         → Anthropic, on the research budget

   The worker is where the real browsing happens (a headless Chromium reading
   public TikTok pages — see harvest/research-worker.mjs); this route only
   stores state in Redis and meters the model. */
const {cors,send,gate,body,kv,K,anthropic}=require('./_lib');

const LEASE_MS=12*60*1000;
const MAX_LOG=300;
const jobKey=id=>K('rs:job:'+id), ckKey=id=>K('rs:ck:'+id), resKey=id=>K('rs:res:'+id), resList=id=>K('rs:resl:'+id);
const LIST=K('rs:jobs');
const cleanId=v=>String(v||'').replace(/[^a-z0-9]/gi,'').slice(0,40);

async function getJob(id){const s=await kv.cmd('GET',jobKey(id));if(!s)return null;try{return JSON.parse(s)}catch(e){return null}}
async function putJob(j){await kv.cmd('SET',jobKey(j.id),JSON.stringify(j))}

function claimable(j,now){
  if(!j)return false;
  if(j.status==='queued')return true;
  if(j.status==='running'&&(j.leaseUntil||0)<now)return true; // worker died mid-run: pick it back up
  return false}

async function recentJobs(n){
  const ids=await kv.cmd('LRANGE',LIST,'0',String((n||30)-1))||[];
  if(!ids.length)return [];
  const raw=await kv.pipe(ids.map(id=>['GET',jobKey(id)]));
  return raw.map(s=>{try{return JSON.parse(s)}catch(e){return null}}).filter(Boolean)}

function summary(j){
  return {id:j.id,status:j.status,createdAt:j.createdAt,updatedAt:j.updatedAt,finishedAt:j.finishedAt||null,
    title:(j.brief&&(j.brief.title||j.brief.brand))||'Research',target:j.target,stats:j.stats||{},phase:j.phase||''}}

function validBrief(b){
  if(!b||typeof b!=='object')return 'brief required';
  if(!String(b.niche_summary||b.persona||'').trim())return 'brief.niche_summary required';
  return ''}

async function dispatchWorker(){
  const tok=process.env.GH_DISPATCH_TOKEN,repo=process.env.GH_REPO||'loubounoob/cadence-app';
  if(!tok)return false;
  try{const r=await fetch(`https://api.github.com/repos/${repo}/actions/workflows/research.yml/dispatches`,{method:'POST',
      headers:{authorization:'Bearer '+tok,accept:'application/vnd.github+json','content-type':'application/json','user-agent':'cadence'},
      body:JSON.stringify({ref:'main'})});
    return r.status===204}catch(e){return false}}

async function browserOp(op,req,res){
  const q=req.query||{};
  if(op==='create'){
    const b=await body(req);const brief=b.brief;
    const err=validBrief(brief);if(err)return send(res,400,{error:{type:'bad_request',message:err}});
    const id='rs'+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
    const target=Math.max(10,Math.min(20000,Number(brief.target_count)||500));
    const now=new Date().toISOString();
    const j={id,status:'queued',createdAt:now,updatedAt:now,brief,target,stats:{},log:[{at:now,m:'Queued — waiting for the research worker.'}],phase:'queued'};
    await putJob(j);
    await kv.pipe([['LPUSH',LIST,id],['LTRIM',LIST,'0','99']]);
    const instant=await dispatchWorker();
    return send(res,200,{ok:true,id,instant})}
  if(op==='jobs'){return send(res,200,{ok:true,jobs:(await recentJobs(30)).map(summary)})}
  if(op==='job'){const j=await getJob(cleanId(q.id));if(!j)return send(res,404,{error:{type:'not_found',message:'no such job'}});
    const total=Number(await kv.cmd('LLEN',resList(j.id)))||0;
    return send(res,200,{ok:true,job:{...j,resultsCount:total}})}
  if(op==='results'){
    const id=cleanId(q.id);const off=Math.max(0,Number(q.offset)||0),lim=Math.max(1,Math.min(400,Number(q.limit)||200));
    const [total,handles]=await kv.pipe([['LLEN',resList(id)],['LRANGE',resList(id),String(off),String(off+lim-1)]]);
    let items=[];
    if(Array.isArray(handles)&&handles.length){
      const vals=await kv.cmd('HMGET',resKey(id),...handles)||[];
      items=vals.map(s=>{try{return JSON.parse(s)}catch(e){return null}}).filter(Boolean)}
    return send(res,200,{ok:true,total:Number(total)||0,offset:off,items})}
  if(op==='cancel'||op==='resume'){
    const b=await body(req);const j=await getJob(cleanId(b.id));if(!j)return send(res,404,{error:{type:'not_found',message:'no such job'}});
    const now=new Date().toISOString();
    if(op==='cancel'){
      if(['done','cancelled','failed'].includes(j.status))return send(res,200,{ok:true,status:j.status});
      j.status=j.status==='queued'?'cancelled':'cancel_requested';
      j.log=[{at:now,m:'Stop requested by you.'},...(j.log||[])].slice(0,MAX_LOG)}
    else{
      j.status='queued';j.leaseUntil=0;j.finishedAt=null;
      if(b.addTarget)j.target=Math.min(20000,(j.target||0)+Math.max(0,Number(b.addTarget)||0));
      j.log=[{at:now,m:'Resumed — the worker will keep searching from where it stopped.'},...(j.log||[])].slice(0,MAX_LOG)}
    j.updatedAt=now;await putJob(j);
    if(op==='resume')await dispatchWorker();
    return send(res,200,{ok:true,status:j.status})}
  return send(res,400,{error:{type:'bad_request',message:'unknown op'}})}

async function workerOp(op,req,res){
  const b=await body(req);const now=Date.now();
  if(op==='peek'){
    const js=await recentJobs(40);
    return send(res,200,{ok:true,work:js.some(j=>claimable(j,now))})}
  if(op==='claim'){
    const js=await recentJobs(40);
    // oldest claimable first, so a queue drains in order
    const j=js.reverse().find(x=>claimable(x,now));
    if(!j)return send(res,200,{ok:true,job:null});
    j.status='running';j.leaseUntil=now+LEASE_MS;j.runner=String(b.runner||'').slice(0,80);
    j.runs=(j.runs||0)+1;j.updatedAt=new Date().toISOString();
    j.log=[{at:j.updatedAt,m:j.runs>1?`Worker resumed the search (session ${j.runs}).`:'Worker started the search.'},...(j.log||[])].slice(0,MAX_LOG);
    await putJob(j);
    const ck=await kv.cmd('GET',ckKey(j.id));
    return send(res,200,{ok:true,job:j,ckpt:ck?JSON.parse(ck):null})}
  if(op==='save'){
    const id=cleanId(b.id);const j=await getJob(id);if(!j)return send(res,404,{error:{type:'not_found',message:'no such job'}});
    const p=b.patch&&typeof b.patch==='object'?b.patch:{};
    const stopAsked=j.status==='cancel_requested';
    ['stats','phase','strategy','report','tags','finishedAt'].forEach(k=>{if(p[k]!==undefined)j[k]=p[k]});
    if(p.status){
      // a stop request always wins over whatever the worker thought it was doing
      j.status=stopAsked&&!['done','cancelled','failed'].includes(p.status)?'cancel_requested':p.status}
    if(Array.isArray(b.log)&&b.log.length){
      const at=new Date().toISOString();
      j.log=[...b.log.slice(-40).reverse().map(m=>({at,m:String(m).slice(0,400)})),...(j.log||[])].slice(0,MAX_LOG)}
    if(j.status==='running')j.leaseUntil=now+LEASE_MS;
    j.updatedAt=new Date().toISOString();
    const cmds=[['SET',jobKey(id),JSON.stringify(j)]];
    if(b.ckpt)cmds.push(['SET',ckKey(id),JSON.stringify(b.ckpt)],['EXPIRE',ckKey(id),String(30*86400)]);
    await kv.pipe(cmds);
    return send(res,200,{ok:true,status:j.status})}
  if(op==='add'){
    const id=cleanId(b.id);const list=Array.isArray(b.creators)?b.creators.slice(0,200):[];
    if(!list.length)return send(res,200,{ok:true,added:0});
    const handles=list.map(c=>String(c.handle||'').toLowerCase()).filter(Boolean);
    const exists=await kv.pipe(handles.map(h=>['HEXISTS',resKey(id),h]));
    const cmds=[];let added=0;
    list.forEach((c,i)=>{const h=handles[i];if(!h)return;
      cmds.push(['HSET',resKey(id),h,JSON.stringify(c)]);   // a re-review updates in place
      if(!Number(exists[i])){cmds.push(['RPUSH',resList(id),h]);added++}});
    if(cmds.length)await kv.pipe(cmds);
    return send(res,200,{ok:true,added})}
  if(op==='ai'){
    const budget={prefix:'rsusage:',cap:Number(process.env.RESEARCH_TOKEN_CAP)||40000000};
    try{const r=await anthropic(b.payload||{},budget);
      if(r.retryAfter)res.setHeader('retry-after',r.retryAfter);
      return send(res,r.status,r.json)}
    catch(e){return send(res,502,{error:{type:'upstream',message:e.message}})}}
  return send(res,400,{error:{type:'bad_request',message:'unknown op'}})}

const WORKER_OPS=['peek','claim','save','add','ai'];

module.exports=async function handler(req,res){
  if(cors(req,res))return;
  const op=String((req.query||{}).op||'');
  if(!kv.ok&&op!=='ai')return send(res,503,{error:{type:'no_storage',message:'Research needs Redis storage.'}});
  if(WORKER_OPS.includes(op)){
    const secret=process.env.FREE_HARVEST_SECRET;
    if(!secret)return send(res,503,{error:{type:'not_configured',message:'FREE_HARVEST_SECRET is not set on the server.'}});
    if(req.headers['x-worker-secret']!==secret)return send(res,401,{error:{type:'auth',message:'bad worker secret'}});
    if(req.method!=='POST')return send(res,405,{error:{type:'method',message:'POST only'}});
    return workerOp(op,req,res)}
  if(!gate(req,res))return;
  return browserOp(op,req,res)};
module.exports._internal={claimable,validBrief};
