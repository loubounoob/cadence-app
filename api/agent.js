/* /api/agent — the same operations agent, running on the server over the copy
   the app last synced. Called by Vercel Cron (daily on Hobby), by any external
   pinger, or by the "Run server agent" button.

   It never sends anything and never touches money. Every change it wants is
   written as an operation the app applies on its next sync: stage moves,
   addresses, emails for approval, to-dos, insights. */
const {MODEL,cors,send,gate,body,kv,K,hgetallObj,anthropic}=require('./_lib');
const A=require('./_analytics');
const DAY=86400000;
const STAGES_DEFAULT=['shortlisted','contacted','replied','negotiating','address_needed','address_ready','shipped','live_pending','live_missing_link','live_ok','declined'];
const uid=()=>Math.random().toString(36).slice(2,10);
const daysSince=t=>t?Math.floor((Date.now()-new Date(t).getTime())/DAY):null;

async function loadState(){
  const [pipe,reply,sent,camp,list,meta,events,ops,flags]=await kv.pipe([
    ['HGETALL',K('rec:pipe')],['HGETALL',K('rec:reply')],['HGETALL',K('rec:sent')],['HGETALL',K('rec:camp')],['HGETALL',K('rec:list')],
    ['GET',K('meta')],['LRANGE',K('events'),'0','299'],['HGETALL',K('ops')],['GET',K('flags')]]);
  let m={};try{m=meta?JSON.parse(meta):{}}catch(e){}
  let f={};try{f=flags?JSON.parse(flags):{}}catch(e){}
  const st={pipe:hgetallObj(pipe),reply:hgetallObj(reply),sent:hgetallObj(sent),camp:hgetallObj(camp),list:hgetallObj(list),meta:m,
    events:(events||[]).map(x=>{try{return JSON.parse(x)}catch(e){return null}}).filter(Boolean),
    ops:hgetallObj(ops),flags:{...(m.flags||{}),...f},newOps:[],newFlags:{}};
  // pending ops are not yet applied in the app: overlay them so the agent sees the latest truth
  for(const op of Object.values(st.ops)){
    const p=st.pipe[op.id];
    if(op.type==='set_stage'&&p)p.stage=op.stage;
    if(op.type==='save_address'&&p){p.addr=op.address;p.stage='address_ready'}
    if(op.type==='ship'&&p)applyShip(p,op)}
  return st}

function applyShip(p,o){const sh=p.ship||(p.ship={status:p.shippedAt?'shipped':'',updates:[]});
  if(o.carrier)sh.carrier=o.carrier;if(o.tracking)sh.tracking=o.tracking;
  if(o.status){sh.status=o.status;if(o.status==='delivered'&&!sh.deliveredAt)sh.deliveredAt=o.at||new Date().toISOString()}}
function op(st,o){const x={id:'srv_'+uid(),at:new Date().toISOString(),...o};st.newOps.push(x);return x}
function flag(st,key,field){const f=st.flags[key]||(st.flags[key]={});f[field]=Date.now();
  (st.newFlags[key]||(st.newFlags[key]={}))[field]=f[field]}
const pendingApprovals=st=>[...Object.values(st.ops),...st.newOps].filter(o=>o.type==='approval').map(o=>o.item);
function rateOverCeiling(st,text){
  const a=st.meta.auto||{},cap=a.maxRate||(st.meta.out&&st.meta.out.rate)||5;
  const PER='\\s*(?:per|\\/|a|les|pour|par)\\s*(?:1[ ,.\\u202f]?000|thousand|1k|mille)';
  const rates=[...String(text).matchAll(new RegExp('[$€]\\s?(\\d+(?:[.,]\\d+)?)'+PER+'|(\\d+(?:[.,]\\d+)?)\\s?(?:\\$|€|dollars?|euros?)'+PER,'gi'))]
    .map(m=>parseFloat((m[1]||m[2]).replace(',','.')));
  return rates.some(x=>x>cap)?`rate above the ceiling of $${cap} per 1,000 views — rewrite within it`:''}
const repliesFor=(st,id)=>Object.values(st.reply).filter(r=>r.creatorId===id).sort((a,b)=>String(b.at).localeCompare(String(a.at)));
const lastAt=p=>p.log&&p.log[0]?p.log[0].at:null;

function tools(st){
  const stages=st.meta.stages||STAGES_DEFAULT;
  const ctx=()=>({pipe:st.pipe,sent:st.sent,replies:Object.values(st.reply),now:Date.now()});
  const sch=n=>A.TOOL_SCHEMAS[n].input_schema;
  const T={
    query_creators:{d:A.TOOL_SCHEMAS.query_creators.description,s:sch('query_creators').properties,r:f=>A.queryCreators(ctx(),f)},
    get_segments:{d:A.TOOL_SCHEMAS.get_segments.description,s:sch('get_segments').properties,req:['dimension'],r:f=>A.segments(ctx(),f)},
    audit_data:{d:A.TOOL_SCHEMAS.audit_data.description,s:{},r:()=>A.audit({...ctx(),camps:st.camp})},
    get_shipments:{d:A.TOOL_SCHEMAS.get_shipments.description,s:sch('get_shipments').properties,
      r:f=>A.shipments(ctx(),{overdue_days:(st.meta.auto&&st.meta.auto.shipCheckDays)||7,...(f||{})})},
    update_shipment:{d:'Record where a parcel is (status, carrier, tracking) with the evidence in note. Only from something real — never guess delivery.',
      s:{id:{type:'string'},status:{type:'string',enum:['shipped','in_transit','delivered','issue','returned']},carrier:{type:'string'},tracking:{type:'string'},note:{type:'string'}},req:['id','note'],
      r:({id,status,carrier,tracking,note})=>{const p=st.pipe[id];if(!p)return {error:'unknown creator id'};
        const o=op(st,{type:'ship',id,status,carrier,tracking,note});applyShip(p,o);return {ok:true}}},
    get_overview:{d:'Snapshot: creators by stage, inbox, campaigns with budget use, pending approvals.',s:{},
      r:()=>{const all=Object.values(st.pipe),by={};stages.forEach(k=>by[k]=all.filter(p=>p.stage===k).length);
        return {today:new Date().toISOString().slice(0,10),creators:all.length,by_stage:by,
          replies:Object.keys(st.reply).length,sent:Object.keys(st.sent).length,
          campaigns:Object.values(st.camp),pending_approvals:pendingApprovals(st).length,
          rate_per_1000:(st.meta.out&&st.meta.out.rate)||5}}},
    get_metrics:{d:'Performance: sends and failures (24h, 7d), reply rate, intents, funnel.',s:{},
      r:()=>{const now=Date.now(),sent=Object.values(st.sent),reps=Object.values(st.reply),w=(t,d)=>t&&now-new Date(t)<d*DAY;
        const ok=sent.filter(s=>s.ok),bad=sent.filter(s=>!s.ok),intents={};
        reps.forEach(r=>{if(r.intent)intents[r.intent]=(intents[r.intent]||0)+1});
        const replied=new Set(reps.map(r=>r.creatorId).filter(Boolean));
        return {sent_total:ok.length,sent_24h:ok.filter(s=>w(s.at,1)).length,sent_7d:ok.filter(s=>w(s.at,7)).length,
          failed_total:bad.length,reply_rate_pct:ok.length?Math.round(replied.size/ok.length*100):0,
          replies_7d:reps.filter(r=>w(r.at,7)).length,intents,campaigns:Object.values(st.camp)}}},
    get_events:{d:'Recent events from every feature, newest first.',s:{type:{type:'string'},since_hours:{type:'number'},limit:{type:'integer'}},
      r:({type,since_hours,limit})=>{let l=st.events;if(type)l=l.filter(e=>e.type===type);
        if(since_hours)l=l.filter(e=>Date.now()-new Date(e.at)<since_hours*3600000);
        return {total:l.length,events:l.slice(0,Math.min(limit||40,150)).map(e=>({at:e.at,type:e.type,category:e.cat,data:e.data}))}}},
    list_creators:{d:'Creators, filtered by stage or text.',s:{stage:{type:'string'},query:{type:'string'},limit:{type:'integer'}},
      r:({stage,query,limit})=>{let l=Object.values(st.pipe);if(stage)l=l.filter(p=>p.stage===stage);
        if(query){const q=String(query).toLowerCase();l=l.filter(p=>[p.name,p.email,p.handle].join(' ').toLowerCase().includes(q))}
        return {total:l.length,creators:l.slice(0,Math.min(limit||25,100)).map(p=>({id:p.id,name:p.name,email:p.email,stage:p.stage,
          days_since_last_event:daysSince(lastAt(p)),has_address:!!p.addr,video:p.videoUrl||''}))}}},
    get_creator:{d:'One creator with history and replies.',s:{id:{type:'string'}},req:['id'],
      r:({id})=>{const p=st.pipe[id];if(!p)return {error:'unknown creator id'};const s=st.sent[id]||{};
        const camps=Object.values(st.camp).flatMap(c=>(c.lines||[]).filter(l=>l.pid===id).map(l=>({campaign:c.id,campaign_name:c.name,rate:l.rate,views:l.views})));
        return {...p,first_email_at:s.at||null,median_views:p.views||s.views||null,campaigns:camps,
          replies:repliesFor(st,id).slice(0,6).map(r=>({reply_id:r.gmId,at:r.at,intent:r.intent,status:r.status,body:(r.body||'').slice(0,1500)}))}}},
    get_campaign:{d:'One campaign summary with per-creator views.',s:{id:{type:'string'}},req:['id'],
      r:({id})=>st.camp[id]||{error:'unknown campaign'}},
    get_lists:{d:'Every saved discovery list: name, how many creators, when saved, its AI summary and a category breakdown.',s:{},
      r:()=>{const ls=Object.values(st.list);return {total:ls.length,lists:ls.map(l=>{
        const by={};(l.items||[]).forEach(it=>{const k=it.category||'(unclassified)';by[k]=(by[k]||0)+1});
        return {id:l.id,name:l.name,count:l.count||(l.items||[]).length,createdAt:l.createdAt,summary:l.summary||'',by_category:by}})}}},
    get_list:{d:'One saved discovery list with every creator in it.',s:{id:{type:'string'}},req:['id'],
      r:({id})=>st.list[id]||{error:'unknown list id'}},
    set_stage:{d:'Move a creator to another stage, with the reason. Only when the data clearly supports it.',
      s:{id:{type:'string'},stage:{type:'string',enum:stages},reason:{type:'string'},allow_backward:{type:'boolean'}},req:['id','stage','reason'],
      r:({id,stage,reason,allow_backward})=>{const p=st.pipe[id];if(!p)return {error:'unknown creator id'};if(!stages.includes(stage))return {error:'unknown stage'};
        const why=A.stageMoveProblem(p.stage||'shortlisted',stage,!!allow_backward);if(why)return {error:why};
        const from=p.stage;p.stage=stage;op(st,{type:'set_stage',id,stage,reason});return {ok:true,from,to:stage}}},
    save_address:{d:'Store an address the creator actually wrote. Never invent fields.',
      s:{id:{type:'string'},address:{type:'object',properties:{name:{type:'string'},line1:{type:'string'},line2:{type:'string'},
        city:{type:'string'},region:{type:'string'},postal:{type:'string'},country:{type:'string'}},required:['line1','city','country']}},req:['id','address'],
      r:({id,address})=>{const p=st.pipe[id];if(!p)return {error:'unknown creator id'};
        if(!address||!address.line1||!address.city)return {error:'address incomplete — ask them instead'};
        p.addr=address;p.stage='address_ready';op(st,{type:'save_address',id,address});return {ok:true}}},
    propose_email:{d:'File an email (follow-up, reminder, counter-offer) for the owner to approve. Never sent without approval.',
      s:{creator_id:{type:'string'},kind:{type:'string',enum:['follow_up','video_reminder','delivery_check','counter_offer','address_request','thanks','other']},
        subject:{type:'string'},body:{type:'string'},reason:{type:'string'}},req:['creator_id','kind','body','reason'],
      r:({creator_id,kind,subject,body,reason})=>{const p=st.pipe[creator_id];if(!p)return {error:'unknown creator id'};
        if(!p.email)return {error:'no email for this creator'};
        const bad=rateOverCeiling(st,body);if(bad)return {error:bad};
        if(pendingApprovals(st).some(i=>i.creatorId===creator_id&&i.kind===kind))return {error:'an approval of this kind is already pending for this creator'};
        const s=st.sent[creator_id]||{};
        const item={id:'ap_'+uid(),type:'email',kind,creatorId:creator_id,title:`${kind.replace('_',' ')} → ${p.name||p.email}`,
          why:reason,to:p.email,subject:subject||'Re: '+((st.meta.out&&st.meta.out.subject)||'our note'),body,threadId:s.gmThreadId||''};
        op(st,{type:'approval',item});return {queued_for_approval:true}}},
    flag_for_human:{d:'Put something on the owner\'s to-do list when only a person can decide.',
      s:{creator_id:{type:'string'},reason:{type:'string'},priority:{type:'string',enum:['high','normal','low']}},req:['reason'],
      r:({creator_id,reason,priority})=>{const p=creator_id&&st.pipe[creator_id];
        op(st,{type:'approval',item:{id:'ap_'+uid(),type:'todo',kind:'todo:'+String(reason).slice(0,40),creatorId:creator_id||'',
          title:p?(p.name||p.email):'General',why:reason,priority:priority||'normal'}});return {ok:true}}},
    record_insight:{d:'Write down a pattern, risk or win the owner should know. Observations only.',
      s:{title:{type:'string'},detail:{type:'string'},category:{type:'string'},priority:{type:'string',enum:['high','normal','low']},creator_id:{type:'string'}},req:['title','category'],
      r:(i)=>{op(st,{type:'insight',item:{id:'in_'+uid(),at:new Date().toISOString(),...i}});return {ok:true}}},
  };
  return T}

function systemPrompt(st){
  const m=st.meta,b=m.brand||{},o=m.out||{},a=m.auto||{},rate=o.rate||5,cap=a.maxRate||rate;
  return `You are the operations brain of Cadence, running on the server while the owner's app is closed. You work on the last synced copy of their data: creators and stages, replies, sends, campaigns, and the event stream from every feature. Everything you change is applied in their app on its next sync. You cannot send anything: emails go to the approval queue.

Brand: ${b.product||'(unnamed)'}${b.url?' — '+b.url:''}${b.market?' — market '+b.market:''}
Offer: $${rate} per 1,000 verified views, paid weekly. Sender: ${o.fromName||'(not set)'}.

${A.DATA_MODEL}

Hard rules (the tools enforce them too):
- Never propose more than $${cap} per 1,000 views, never a flat fee, never a guaranteed minimum.
- Never invent a fact, an address, a view count or a date.
- Creator-facing emails: plain, under 110 words, no marketing tone, no exclamation marks, signed with the sender's first name, in the creator's language.
- One action per creator per situation. Observations → record_insight. Decisions only a person can make → flag_for_human.
- Never estimate a count: numbers come from the tools, which run over every record. A reply marked needsReview is not acted on.
- A parcel is delivered only when the creator or the owner says so; record it with update_shipment and the evidence.

Finish with one short line summarising what you did.`}

/* Plain-code scan: the same situations the app looks for, deduplicated with
   the flags the app already set so nothing is done twice. */
function scan(st){
  const a=st.meta.auto||{},now=Date.now(),out=[];
  const fu=(a.followUpDays||5)*DAY,rm=(a.remindDays||14)*DAY,alert=(a.budgetAlert||0.85)*100;
  for(const p of Object.values(st.pipe)){
    const f=st.flags[p.id]||{},s=st.sent[p.id];
    if(p.stage==='contacted'&&s&&s.ok&&!f.followUp&&now-new Date(s.at)>fu&&!repliesFor(st,p.id).length){
      flag(st,p.id,'followUp');out.push(`creator_id=${p.id} (${p.name||p.email}) got our first email ${daysSince(s.at)} days ago and never replied → file ONE short follow-up with propose_email kind=follow_up.`)}
    const sh=p.ship||{},delivered=sh.status==='delivered',sc=(a.shipCheckDays||7)*DAY;
    if(p.shippedAt&&!delivered&&!['issue','returned'].includes(sh.status)&&!p.videoUrl&&!f.shipCheck&&['shipped','live_pending'].includes(p.stage)&&now-new Date(p.shippedAt)>sc){
      flag(st,p.id,'shipCheck');out.push(`creator_id=${p.id} (${p.name||p.email}) was shipped the product ${daysSince(p.shippedAt)} days ago, delivery never confirmed → if a reply already says it arrived, update_shipment status=delivered quoting it; else propose_email kind=delivery_check.`)}
    const since=delivered&&sh.deliveredAt?sh.deliveredAt:p.shippedAt,wait=delivered?(a.videoAfterDeliveryDays||7)*DAY:rm;
    if(p.stage==='shipped'&&!p.videoUrl&&since&&!f.remind&&now-new Date(since)>wait){
      flag(st,p.id,'remind');out.push(`creator_id=${p.id} (${p.name||p.email}) ${delivered?'has had the product (delivery confirmed)':'was shipped the product'} ${daysSince(since)} days ago, no video logged → file a friendly reminder with propose_email kind=video_reminder.`)}
    if(p.stage==='negotiating'&&!f.negFlag&&lastAt(p)&&now-new Date(lastAt(p))>2*DAY){
      flag(st,p.id,'negFlag');out.push(`creator_id=${p.id} (${p.name||p.email}) has been negotiating for ${daysSince(lastAt(p))} days → read their replies, flag_for_human with a one-line recommendation.`)}
  }
  for(const c of Object.values(st.camp)){
    const f=st.flags['camp:'+c.id]||{},band=Math.floor((c.budget_used_pct||0)/5);
    if(c.budget&&c.budget_used_pct>=alert&&f.alertAt!==band){
      (st.flags['camp:'+c.id]=st.flags['camp:'+c.id]||{}).alertAt=band;(st.newFlags['camp:'+c.id]=st.newFlags['camp:'+c.id]||{}).alertAt=band;
      out.push(`Campaign ${c.id} (${c.name}) is at ${c.budget_used_pct}% of its budget → flag_for_human priority high with a recommendation.`)}
  }
  return out}

async function run(st,source){
  const situations=scan(st);
  const T=tools(st);
  const defs=Object.entries(T).map(([name,t])=>({name,description:t.d,input_schema:{type:'object',properties:t.s,...(t.req?{required:t.req}:{})}}));
  const recent=st.events.filter(e=>Date.now()-new Date(e.at)<DAY).length;
  const au=A.audit({pipe:st.pipe,sent:st.sent,replies:Object.values(st.reply),now:Date.now(),camps:st.camp});
  const auditTxt=au.issues.length?au.issues.slice(0,12).map(i=>`- ${i.check} [${i.severity}] ×${i.count}: ${JSON.stringify(i.examples.slice(0,4))}`).join('\n'):'- none';
  const prompt=`Run: ${source}. ${new Date().toISOString()}.
${situations.length?`Situations found by the scan (handle each, one action each):\n- ${situations.slice(0,15).join('\n- ')}`:'The scan found nothing that needs a follow-up, reminder or alert.'}

Data audit, computed in code over all ${au.creators} creators (exact): ${au.issues_total} problem(s)
${auditTxt}
Fix what the data proves and the tools allow; flag_for_human once for each high-severity problem you cannot fix.

${recent} events arrived in the last 24 hours. Then: read get_shipments, read get_metrics, the recent events and get_segments (views_band and keyword at least), and record ONE insight titled "Daily brief" with the 3–5 numbers that matter, deliveries, which segment converts best and worst, and what the owner should do first today. Record other insights only if something is truly off.`;
  const messages=[{role:'user',content:prompt}];
  const actions=[];let text='',usage={in:0,out:0};
  for(let step=0;step<10;step++){
    const r=await anthropic({system:[{type:'text',text:systemPrompt(st),cache_control:{type:'ephemeral'}}],tools:defs,messages,max_tokens:1600});
    if(r.status!==200)throw new Error((r.json.error&&r.json.error.message)||('Anthropic HTTP '+r.status));
    const j=r.json;usage.in+=(j.usage&&j.usage.input_tokens)||0;usage.out+=(j.usage&&j.usage.output_tokens)||0;
    messages.push({role:'assistant',content:j.content});
    const uses=(j.content||[]).filter(b=>b.type==='tool_use');
    text=(j.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('').trim()||text;
    if(j.stop_reason!=='tool_use'||!uses.length)break;
    const results=[];
    for(const u of uses){let out;const t=T[u.name];
      try{out=t?t.r(u.input||{}):{error:'unknown tool'}}catch(e){out={error:e.message}}
      actions.push({tool:u.name,ok:!(out&&out.error)});
      results.push({type:'tool_result',tool_use_id:u.id,content:JSON.stringify(out).slice(0,9000),...(out&&out.error?{is_error:true}:{})})}
    messages.push({role:'user',content:results})}
  return {situations:situations.length,actions,text,usage}}

module.exports=async function handler(req,res){
  if(cors(req,res))return;
  const isCron=!!req.headers['x-vercel-cron']||(req.headers['user-agent']||'').includes('vercel-cron');
  const secret=process.env.CRON_SECRET;
  const bearerOk=secret&&req.headers.authorization==='Bearer '+secret;
  if(secret&&isCron&&!bearerOk)return send(res,401,{error:{type:'cron',message:'bad cron secret'}});
  if(!isCron&&!bearerOk&&!gate(req,res))return;
  if(!process.env.ANTHROPIC_API_KEY)return send(res,503,{error:{type:'no_key',message:'ANTHROPIC_API_KEY is not set on the server.'}});
  if(!kv.ok)return send(res,503,{error:{type:'no_storage',message:'No server memory. Add Upstash Redis to this project so the agent can run while the app is closed.'}});
  const lock=await kv.cmd('SET',K('agent:lock'),'1','NX','EX','90');
  if(lock!=='OK')return send(res,409,{error:{type:'busy',message:'The server agent is already running.'}});
  const source=isCron?'cron':((req.query&&req.query.source)||((await body(req)).source)||'manual');
  try{
    const st=await loadState();
    if(!Object.keys(st.pipe).length&&!Object.keys(st.camp).length){
      await kv.cmd('DEL',K('agent:lock'));
      return send(res,200,{ok:true,skipped:'nothing synced yet'})}
    const r=await run(st,source);
    const cmds=[];
    if(st.newOps.length)cmds.push(['HSET',K('ops'),...st.newOps.flatMap(o=>[o.id,JSON.stringify(o)])]);
    if(Object.keys(st.newFlags).length){
      const flagOp={id:'srv_'+uid(),at:new Date().toISOString(),type:'flags',flags:st.newFlags};
      cmds.push(['HSET',K('ops'),flagOp.id,JSON.stringify(flagOp)]);
      cmds.push(['SET',K('flags'),JSON.stringify(st.flags)])}
    const summary={at:new Date().toISOString(),source,situations:r.situations,ops:st.newOps.length,
      tools:r.actions.length,tokens:r.usage.in+r.usage.out,text:String(r.text).slice(0,300)};
    const logOp={id:'srv_'+uid(),at:summary.at,type:'log',msg:`${source} run — ${summary.situations} situation(s), ${summary.ops} change(s). ${summary.text}`};
    cmds.push(['HSET',K('ops'),logOp.id,JSON.stringify(logOp)]);
    cmds.push(['SET',K('agent:last'),JSON.stringify(summary)]);
    cmds.push(['LPUSH',K('agent:log'),JSON.stringify(summary)],['LTRIM',K('agent:log'),'0','99']);
    cmds.push(['DEL',K('agent:lock')]);
    await kv.pipe(cmds);
    send(res,200,{ok:true,...summary});
  }catch(e){await kv.cmd('DEL',K('agent:lock')).catch(()=>{});send(res,500,{error:{type:'agent',message:e.message}})}
};
module.exports._internal={loadState,scan,tools,run};
