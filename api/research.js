/* /api/research — AI-supervised deep creator research, with no paid scraper.

   BROWSER (behind the usual access-code gate)
     POST ?op=create   {brief}          → queue a research job (split in N shards)
     GET  ?op=jobs                       → the last 30 jobs, summaries only
     GET  ?op=job&id=                    → one job: status, progress, log
     GET  ?op=results&id=&offset=&limit= → accepted creators, paged
     POST ?op=cancel   {id}              → ask every worker on it to stop
     POST ?op=resume   {id,addTarget}    → requeue a stopped/finished job
     GET  ?op=pool                       → size of the shared creator base

   WORKER (harvest/research-worker.mjs on GitHub Actions; header
   x-worker-secret = FREE_HARVEST_SECRET — never a URL parameter)
     POST ?op=peek                        → how many shards can be claimed
     POST ?op=claim     {runner}          → lease one shard of a job + its checkpoint
     POST ?op=save      {id,shard,…}      → progress, checkpoint, lease renewal;
                                             answers with the job-wide totals
     POST ?op=add       {id,creators}     → append accepted creators
     POST ?op=mark      {id,handles}      → shared dedupe: which handles are new to this job
     POST ?op=src-add   {id,items}        → shared source queue (hashtags, keywords, sounds…)
     POST ?op=src-next  {id,n}            → pop the best sources for this machine
     POST ?op=pool-put  {creators}        → upsert into the shared creator base
     POST ?op=pool-scan {cursor,count}    → page through the shared creator base
     POST ?op=ai        {payload}         → Anthropic, on the research budget

   Several machines work one job at once: each leases a shard, they share one
   priority queue of sources and one "seen" set, and all stop together when the
   job-wide target or budget is reached. The shared creator base outlives jobs:
   every creator ever read is kept (compactly) so later searches start from it. */
const {cors,send,gate,body,kv,K,anthropic}=require('./_lib');

const LEASE_MS=12*60*1000;
const MAX_LOG=400;
const DEFAULT_SHARDS=Math.max(1,Math.min(8,Number(process.env.RESEARCH_SHARDS)||4));
const jobKey=id=>K('rs:job:'+id),ckKey=(id,k)=>K(`rs:ck:${id}:${k}`),resKey=id=>K('rs:res:'+id),resList=id=>K('rs:resl:'+id);
const seenKey=id=>K('rs:seen:'+id),srcQ=id=>K('rs:sq:'+id),srcAll=id=>K('rs:sa:'+id);
const POOL=K('rs:pool');
const LIST=K('rs:jobs');
const TTL=String(45*86400);
const cleanId=v=>String(v||'').replace(/[^a-z0-9]/gi,'').slice(0,40);

async function getJob(id){const s=await kv.cmd('GET',jobKey(id));if(!s)return null;try{return JSON.parse(s)}catch(e){return null}}
async function putJob(j){await kv.cmd('SET',jobKey(j.id),JSON.stringify(j))}

/* Older single-machine jobs have no shard map: they behave as one shard. */
function shardsOf(j){
  if(!j.shard){j.shard={};const n=j.nShards||1;for(let k=0;k<n;k++)j.shard[k]={status:j.status==='running'?'running':'queued',leaseUntil:j.leaseUntil||0,runs:0,stats:{}}}
  return j.shard}
function claimableShards(j,now){
  if(!j||!['queued','running'].includes(j.status))return [];
  return Object.entries(shardsOf(j)).filter(([,s])=>s.status==='queued'||(s.status==='running'&&(s.leaseUntil||0)<now)).map(([k])=>Number(k))}

const NUM_KEYS=['postsRead','authorsSeen','gated','triaged','triagePassed','dossiers','dossierFail','vetted','escalated','accepted','rejected',
  'tagsDone','sourcesDone','poolHits','tokensIn','tokensOut','costUsd','elapsedMs'];
function aggregate(j){
  const out={queue:{triage:0,dossier:0,vetting:0},machines:0,elapsedMs:0};
  for(const s of Object.values(shardsOf(j))){const st=s.stats||{};
    NUM_KEYS.forEach(k=>{if(k==='elapsedMs')out.elapsedMs=Math.max(out.elapsedMs,st.elapsedMs||0);else out[k]=+((out[k]||0)+(Number(st[k])||0)).toFixed(4)});
    const q=st.queue||{};['triage','dossier','vetting'].forEach(k=>out.queue[k]+=Number(q[k])||0);
    if(s.status==='running'&&(s.leaseUntil||0)>Date.now())out.machines++}
  out.sourcesQueued=j.sourcesQueued||0;
  return out}
function rollStatus(j){
  const ss=Object.values(shardsOf(j));
  if(ss.every(s=>s.status==='done')){
    if(j.status==='cancel_requested'||j.stopWhy==='cancelled')j.status='cancelled';else j.status='done';
    j.finishedAt=j.finishedAt||new Date().toISOString();return}
  if(j.status==='cancel_requested')return;
  j.status=ss.some(s=>s.status==='running'&&(s.leaseUntil||0)>Date.now())?'running':'queued'}

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

function logLines(j,lines,prefix){
  const at=new Date().toISOString();
  j.log=[...lines.slice(-60).reverse().map(m=>({at,m:(prefix||'')+String(m).slice(0,400)})),...(j.log||[])].slice(0,MAX_LOG)}

async function browserOp(op,req,res){
  const q=req.query||{};
  if(op==='create'){
    const b=await body(req);const brief=b.brief;
    const err=validBrief(brief);if(err)return send(res,400,{error:{type:'bad_request',message:err}});
    const id='rs'+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
    const target=Math.max(10,Math.min(20000,Number(brief.target_count)||500));
    const n=Math.max(1,Math.min(8,Number(brief.machines)||(target<=50?1:DEFAULT_SHARDS)));
    const now=new Date().toISOString();
    const shard={};for(let k=0;k<n;k++)shard[k]={status:'queued',leaseUntil:0,runs:0,stats:{}};
    const j={id,status:'queued',createdAt:now,updatedAt:now,brief,target,nShards:n,shard,stats:{},planned:false,
      log:[{at:now,m:`Queued — ${n} machine${n>1?'s':''} will work on it in parallel.`}],phase:'queued'};
    await putJob(j);
    await kv.pipe([['LPUSH',LIST,id],['LTRIM',LIST,'0','99']]);
    const instant=await dispatchWorker();
    return send(res,200,{ok:true,id,instant,machines:n})}
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
  if(op==='pool'){const n=Number(await kv.cmd('HLEN',POOL))||0;return send(res,200,{ok:true,creators:n})}
  if(op==='cancel'||op==='resume'){
    const b=await body(req);const j=await getJob(cleanId(b.id));if(!j)return send(res,404,{error:{type:'not_found',message:'no such job'}});
    const now=new Date().toISOString();shardsOf(j);
    if(op==='cancel'){
      if(['done','cancelled','failed'].includes(j.status))return send(res,200,{ok:true,status:j.status});
      if(j.status==='queued'&&!Object.values(j.shard).some(s=>s.status==='running')){j.status='cancelled';Object.values(j.shard).forEach(s=>{s.status='done'});j.finishedAt=now}
      else j.status='cancel_requested';
      j.stopWhy='cancelled';
      logLines(j,['Stop requested by you.'])}
    else{
      j.status='queued';j.finishedAt=null;j.stopWhy='';j.report='';
      Object.values(j.shard).forEach(s=>{s.status='queued';s.leaseUntil=0});
      if(b.addTarget)j.target=Math.min(20000,(j.target||0)+Math.max(0,Number(b.addTarget)||0));
      if(b.addBudget){j.brief={...j.brief,max_cost_usd:(Number(j.brief.max_cost_usd)||0)+Math.max(0,Number(b.addBudget)||0)}}
      logLines(j,['Resumed — every machine picks up from where it stopped.'])}
    j.updatedAt=now;await putJob(j);
    if(op==='resume')await dispatchWorker();
    return send(res,200,{ok:true,status:j.status})}
  return send(res,400,{error:{type:'bad_request',message:'unknown op'}})}

async function workerOp(op,req,res){
  const b=await body(req);const now=Date.now();
  if(op==='peek'){
    const js=await recentJobs(40);
    const n=js.reduce((a,j)=>a+claimableShards(j,now).length,0);
    return send(res,200,{ok:true,work:n>0,shards:n})}
  if(op==='claim'){
    const js=(await recentJobs(40)).reverse(); // oldest first, so a queue drains in order
    for(const j of js){
      const free=claimableShards(j,now);if(!free.length)continue;
      const k=free[0];const s=j.shard[k];
      s.status='running';s.leaseUntil=now+LEASE_MS;s.runner=String(b.runner||'').slice(0,80);s.runs=(s.runs||0)+1;
      let planner=false;
      if(!j.planned&&(!j.planLease||j.planLease<now)){planner=true;j.planLease=now+15*60000}
      j.status=j.status==='cancel_requested'?j.status:'running';j.updatedAt=new Date().toISOString();
      logLines(j,[s.runs>1?`Machine ${k+1} resumed (session ${s.runs}).`:`Machine ${k+1} started.`]);
      await putJob(j);
      const ck=await kv.cmd('GET',ckKey(j.id,k))||(k===0?await kv.cmd('GET',K('rs:ck:'+j.id)):null);
      const total=Number(await kv.cmd('LLEN',resList(j.id)))||0;
      return send(res,200,{ok:true,job:j,shard:k,planner,accepted:total,ckpt:ck?JSON.parse(ck):null})}
    return send(res,200,{ok:true,job:null})}
  if(op==='save'){
    const id=cleanId(b.id);const j=await getJob(id);if(!j)return send(res,404,{error:{type:'not_found',message:'no such job'}});
    const k=Number(b.shard)||0;shardsOf(j);const s=j.shard[k]||(j.shard[k]={status:'running',runs:1,stats:{}});
    const p=b.patch&&typeof b.patch==='object'?b.patch:{};
    if(p.stats)s.stats=p.stats;
    if(p.shardStatus)s.status=p.shardStatus;
    else if(p.status){ // older worker builds report a job status: map it onto their shard
      if(['done','cancelled','failed'].includes(p.status)){s.status='done';if(p.status==='cancelled')j.stopWhy=j.stopWhy||'cancelled'}
      else if(p.status==='queued')s.status='queued'}
    if(p.finishedAt&&!j.finishedAt&&Object.keys(j.shard).length===1)j.finishedAt=p.finishedAt;
    if(s.status==='running')s.leaseUntil=now+LEASE_MS;
    if(p.plan){j.planned=true;j.disq=p.plan.disq||[];j.persona=p.plan.persona||'';j.keywords=p.plan.keywords||[]}
    if(p.strategy)j.strategy={...(j.strategy||{}),...p.strategy};
    if(p.phase)j.phase=p.phase;
    if(p.report)j.report=p.report;
    if(p.stopWhy&&!j.stopWhy)j.stopWhy=p.stopWhy;
    if(Array.isArray(b.log)&&b.log.length)logLines(j,b.log,j.nShards>1?`[${k+1}] `:'');
    const [total,qn]=await kv.pipe([['LLEN',resList(id)],['ZCARD',srcQ(id)]]);
    j.sourcesQueued=Number(qn)||0;
    j.stats=aggregate(j);j.stats.accepted=Number(total)||0;
    rollStatus(j);
    j.updatedAt=new Date().toISOString();
    const cmds=[['SET',jobKey(id),JSON.stringify(j)]];
    if(b.ckpt)cmds.push(['SET',ckKey(id,k),JSON.stringify(b.ckpt)],['EXPIRE',ckKey(id,k),TTL]);
    await kv.pipe(cmds);
    return send(res,200,{ok:true,status:j.status,accepted:j.stats.accepted,costUsd:j.stats.costUsd||0,target:j.target,
      budget:Number(j.brief&&j.brief.max_cost_usd)||0,planned:!!j.planned,disq:j.disq||[],persona:j.persona||'',keywords:j.keywords||[],
      stopWhy:j.stopWhy||'',allDone:['done','cancelled'].includes(j.status),reportWritten:!!j.report})}
  if(op==='add'){
    const id=cleanId(b.id);const list=Array.isArray(b.creators)?b.creators.slice(0,200):[];
    if(!list.length)return send(res,200,{ok:true,added:0});
    const handles=list.map(c=>String(c.handle||'').toLowerCase());
    const exists=await kv.pipe(handles.map(h=>['HEXISTS',resKey(id),h]));
    const cmds=[];let added=0;
    list.forEach((c,i)=>{const h=handles[i];if(!h)return;
      cmds.push(['HSET',resKey(id),h,JSON.stringify(c)]);
      if(!Number(exists[i])){cmds.push(['RPUSH',resList(id),h]);added++}});
    if(cmds.length)await kv.pipe(cmds);
    const total=Number(await kv.cmd('LLEN',resList(id)))||0;
    return send(res,200,{ok:true,added,accepted:total})}
  if(op==='mark'){
    const id=cleanId(b.id);const hs=[...new Set((Array.isArray(b.handles)?b.handles:[]).map(h=>String(h).toLowerCase()).filter(Boolean))].slice(0,1000);
    if(!hs.length)return send(res,200,{ok:true,fresh:[]});
    const r=await kv.pipe([...hs.map(h=>['SADD',seenKey(id),h]),['EXPIRE',seenKey(id),TTL]]);
    return send(res,200,{ok:true,fresh:hs.filter((h,i)=>Number(r[i])===1)})}
  if(op==='src-add'){
    const id=cleanId(b.id);const items=(Array.isArray(b.items)?b.items:[]).slice(0,300)
      .map(x=>({key:String(x.key||'').slice(0,120),pri:Math.max(0,Math.min(100,Number(x.pri)||50))})).filter(x=>/^[a-z]:/.test(x.key));
    if(!items.length)return send(res,200,{ok:true,added:0});
    const r=await kv.pipe(items.map(x=>['SADD',srcAll(id),x.key]));
    const fresh=items.filter((x,i)=>Number(r[i])===1);
    if(fresh.length)await kv.pipe([...fresh.map(x=>['ZADD',srcQ(id),String(x.pri),x.key]),['EXPIRE',srcQ(id),TTL],['EXPIRE',srcAll(id),TTL]]);
    return send(res,200,{ok:true,added:fresh.length,keys:fresh.map(x=>x.key)})}
  if(op==='src-next'){
    const id=cleanId(b.id);const n=Math.max(1,Math.min(20,Number(b.n)||3));
    const r=await kv.cmd('ZPOPMAX',srcQ(id),String(n))||[];
    const items=[];for(let i=0;i<r.length;i+=2)items.push({key:r[i],pri:Number(r[i+1])||0});
    return send(res,200,{ok:true,items})}
  if(op==='pool-put'){
    const list=(Array.isArray(b.creators)?b.creators:[]).slice(0,300).filter(c=>c&&c.h);
    if(!list.length)return send(res,200,{ok:true,stored:0});
    // merge with what is already known, so a lite record never overwrites a full one
    const old=await kv.cmd('HMGET',POOL,...list.map(c=>String(c.h)))||[];
    const cmds=list.map((c,i)=>{let o={};try{o=old[i]?JSON.parse(old[i]):{}}catch(e){}
      const m={...o,...c};if(o.c&&o.c.length>(c.c||[]).length)m.c=o.c;if(o.m&&!c.m)m.m=o.m;if(o.ct&&!c.ct)m.ct=o.ct;if(o.ni&&!c.ni){m.ni=o.ni;m.sf=o.sf;m.fl=o.fl}
      return ['HSET',POOL,String(c.h),JSON.stringify(m)]});
    await kv.pipe(cmds);
    return send(res,200,{ok:true,stored:list.length})}
  if(op==='pool-scan'){
    const r=await kv.cmd('HSCAN',POOL,String(b.cursor||'0'),'COUNT',String(Math.max(10,Math.min(1000,Number(b.count)||500))))||['0',[]];
    const flat=r[1]||[];const items=[];for(let i=0;i<flat.length;i+=2){try{items.push(JSON.parse(flat[i+1]))}catch(e){}}
    return send(res,200,{ok:true,cursor:String(r[0]),items})}
  if(op==='ai'){
    const budget={prefix:'rsusage:',cap:Number(process.env.RESEARCH_TOKEN_CAP)||40000000};
    try{const r=await anthropic(b.payload||{},budget);
      if(r.retryAfter)res.setHeader('retry-after',r.retryAfter);
      return send(res,r.status,r.json)}
    catch(e){return send(res,502,{error:{type:'upstream',message:e.message}})}}
  return send(res,400,{error:{type:'bad_request',message:'unknown op'}})}

const WORKER_OPS=['peek','claim','save','add','mark','src-add','src-next','pool-put','pool-scan','ai'];

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
module.exports._internal={claimableShards,validBrief,aggregate,rollStatus};
