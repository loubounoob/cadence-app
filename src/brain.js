
/* ═══ BRAIN — one Sonnet agent wired into every data stream ══════════════
   The key never touches this page. Every model call goes to /api/ai on the
   Cadence backend, which holds ANTHROPIC_API_KEY as a server secret and forces
   the model to Sonnet whatever the page asks for.

   Data flow, end to end:
   1. emit()  — every feature reports what just happened: leads saved, emails
      sent or bounced, replies, stage moves, videos, views, payouts, settings.
   2. route   — plain rules sort each event: act now, batch for the digest, or
      ignore. Nothing here costs a model call.
   3. react   — "now" events start an agent job at once. Batched events are
      read together by Sonnet every few minutes (or at 25 events): it classifies
      them, spots patterns, records insights and acts through tools.
   4. scan    — plain code looks for situations nobody reported: silence,
      late videos, stuck negotiations, budgets. Only real ones reach the model.
   5. sync    — events and records go to the backend, which keeps a copy and
      runs the same agent on a schedule while this tab is closed. What it does
      comes back here as operations and is applied on the next sync.

   Anything that commits money or speaks for you in a negotiation goes to the
   approval queue. That rule is in the tool code, not the prompt.
   ═════════════════════════════════════════════════════════════════════════ */
const AI_MODEL='claude-sonnet-5';
const PROD_ORIGIN='https://cadence-app-amber.vercel.app';
const API_BASE=(typeof location!=='undefined'&&/^https?:$/.test(location.protocol)&&!/^(localhost|127\.)/.test(location.hostname))?'':PROD_ORIGIN;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const DAY=86400000;

function aiCfg(){
  if(!db.ai)db.ai={};
  const a=db.ai;
  delete a.key; // keys from older builds are dropped — the backend holds the only one
  a.model=AI_MODEL;
  if(!a.usage)a.usage={calls:0,inTok:0,outTok:0,cached:0,errors:0};
  a.auto={on:false,followUpDays:5,remindDays:14,budgetAlert:0.85,maxRate:null,
    autoSend:['OUT_OF_OFFICE'],scanEveryMin:30,lastScan:0,digestEveryMin:10,
    shipCheckDays:7,videoAfterDeliveryDays:7,reviewBelow:0.75,lastSupervise:0,...(a.auto||{})};
  if(!a.memory)a.memory='';
  if(!a.backend)a.backend={checked:false,key:false,storage:false,at:0,err:''};
  if(!a.approvals)a.approvals=[];
  if(!a.chat)a.chat=[];
  if(!a.flags)a.flags={};
  if(!a.insights)a.insights=[];
  if(!a.events)a.events=[];
  if(!a.sync)a.sync={hashes:{},lastAt:0,ack:[],pushedEvents:0,err:''};
  return a}
const aiReady=()=>!!aiCfg().backend.key;

async function apiFetch(path,opts){
  const c=aiCfg();
  const headers={'content-type':'application/json',...((opts&&opts.headers)||{})};
  if(c.code)headers['x-cadence-code']=c.code;
  return fetch(API_BASE+path,{...(opts||{}),headers})}

async function checkBackend(){
  const b=aiCfg().backend;
  try{
    const r=await apiFetch('/api/health',{method:'GET'});
    const j=await r.json();
    Object.assign(b,{checked:true,key:!!j.key,storage:!!j.storage,codeRequired:!!j.access_code,
      model:j.model||AI_MODEL,at:Date.now(),err:j.key?'':'The server has no ANTHROPIC_API_KEY yet.'});
  }catch(e){Object.assign(b,{checked:true,key:false,storage:false,at:Date.now(),err:'Backend unreachable — '+e.message})}
  save();renderAiIfOpen();return b}

/* ── transport: retries, concurrency cap, usage metering ───────────────── */
let aiInflight=0;const aiWaiters=[];const AI_MAX_PARALLEL=3;
async function aiAcquire(){while(aiInflight>=AI_MAX_PARALLEL)await new Promise(r=>aiWaiters.push(r));aiInflight++}
function aiRelease(){aiInflight--;const n=aiWaiters.shift();if(n)n()}

async function claudeCall(body,tier){
  const c=aiCfg();
  if(!aiReady())throw new Error(c.backend.err||'The AI backend is not connected yet.');
  /* tier is a hint only — the server picks the real model from a fixed map
     (see api/_lib.js MODELS) and ignores anything else, so this never lets
     the page choose an arbitrary model. Default stays Sonnet for every
     existing call site. */
  const req={...body,model:AI_MODEL,tier:tier||'sonnet'};
  await aiAcquire();
  try{
    let last='';
    for(let attempt=0;attempt<4;attempt++){
      let r;
      try{r=await apiFetch('/api/ai',{method:'POST',body:JSON.stringify(req)})}
      catch(e){last=e.message;await sleep(800*2**attempt);continue}
      if(r.status===429||r.status===529||r.status>=500){
        let j={};try{j=await r.json()}catch(e){}
        if(j.error&&(j.error.type==='no_key'||j.error.type==='daily_cap')){c.usage.errors++;save();throw new Error(j.error.message)}
        last='HTTP '+r.status;
        const ra=Number(r.headers&&r.headers.get&&r.headers.get('retry-after'))||0;
        await sleep(ra?ra*1000:1000*2**attempt+Math.random()*400);continue}
      const j=await r.json();
      if(j.error){c.usage.errors++;save();
        if(j.error.type==='access_code'){c.backend.err=j.error.message;renderAiIfOpen()}
        throw new Error(j.error.message||'Model refused the request')}
      const u=j.usage||{};
      c.usage.calls++;c.usage.inTok+=u.input_tokens||0;c.usage.outTok+=u.output_tokens||0;
      c.usage.cached+=u.cache_read_input_tokens||0;save();
      return j}
    c.usage.errors++;save();
    throw new Error('The model did not answer after 4 tries ('+last+')');
  }finally{aiRelease()}
}
const textOf=j=>(j.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('').trim();
const sys=t=>[{type:'text',text:t,cache_control:{type:'ephemeral'}}];

async function runAgent(agentId,task,maxTokens,tier){
  const a=AGENTS[agentId];
  const j=await claudeCall({max_tokens:maxTokens||900,system:sys(a.system),
    messages:[{role:'user',content:task}]},tier);
  return textOf(j)}

async function runJSON(agentId,task,maxTokens,tier){
  const t=await runAgent(agentId,task+'\n\nReturn only one JSON object.',maxTokens||400,tier);
  const m=t.match(/\{[\s\S]*\}/);if(!m)throw new Error('No JSON in model answer');
  return JSON.parse(m[0])}

/* ═══ EVENT BUS ═══════════════════════════════════════════════════════════ */
const EVENT_RULES={
  reply_received:{route:'now',cat:'inbox'},
  reply_triaged:{route:'now',cat:'inbox'},
  manual_reply:{route:'now',cat:'inbox'},
  email_failed:{route:'now',cat:'outreach',sev:'warn'},
  payout:{route:'now',cat:'money'},
  video_missing_link:{route:'now',cat:'compliance',sev:'warn'},
  leads_saved:{route:'batch',cat:'discovery'},
  discovery_failed:{route:'batch',cat:'discovery',sev:'warn'},
  roster_built:{route:'batch',cat:'match'},
  discovery_started:{route:'batch',cat:'discovery'},
  discovery_harvested:{route:'batch',cat:'discovery'},
  discovery_done:{route:'now',cat:'discovery'},
  leads_status:{route:'batch',cat:'discovery'},
  queued:{route:'batch',cat:'outreach'},
  email_sent:{route:'batch',cat:'outreach'},
  sending_started:{route:'batch',cat:'outreach'},
  sending_stopped:{route:'batch',cat:'outreach'},
  stage_changed:{route:'batch',cat:'pipeline'},
  address_captured:{route:'batch',cat:'pipeline'},
  delivered:{route:'batch',cat:'pipeline'},
  shipment_updated:{route:'batch',cat:'pipeline'},
  delivery_issue:{route:'now',cat:'pipeline',sev:'warn'},
  shipped:{route:'batch',cat:'pipeline'},
  video_ok:{route:'batch',cat:'compliance'},
  video_added:{route:'batch',cat:'campaign'},
  views_updated:{route:'batch',cat:'campaign'},
  campaign_launched:{route:'batch',cat:'campaign'},
  brand_updated:{route:'batch',cat:'settings'},
  list_saved:{route:'batch',cat:'discovery'},
  list_classified:{route:'batch',cat:'discovery'},
  list_deleted:{route:'batch',cat:'discovery'},
  approval_decided:{route:'batch',cat:'you'},
  app_error:{route:'ignore',cat:'system'},
};
const routeOf=t=>(EVENT_RULES[t]||{route:'batch'}).route;

/* High-volume events fold into the previous one for two minutes, so a run that
   sends 800 emails is one line in the stream, not 800. */
const MERGEABLE=new Set(['leads_saved','email_sent','views_updated']);
function emit(type,data){
  try{
    const a=aiCfg(),r=EVENT_RULES[type]||{route:'batch',cat:'other'};
    const top=a.events[0];
    if(MERGEABLE.has(type)&&top&&top.type===type&&!top.digested&&!top.synced&&Date.now()-new Date(top.at).getTime()<120000){
      const d=data||{};top.data.count=(top.data.count||1)+1;
      for(const k of ['added','seen'])if(typeof d[k]==='number')top.data[k]=(top.data[k]||0)+d[k];
      if(d.views!=null)top.data.views=d.views;
      if(d.name)top.data.last=d.name;
      save();renderAiIfOpen();return top}
    const ev={id:uid(),at:new Date().toISOString(),type,cat:r.cat||'other',sev:r.sev||'info',
      route:r.route,data:data||{},digested:r.route!=='batch',synced:false};
    a.events.unshift(ev);
    if(a.events.length>600)a.events.length=600;
    save();
    if(r.route==='now')reactNow(ev);
    else if(r.route==='batch'&&a.auto.on&&aiReady()){
      const pending=a.events.filter(e=>!e.digested).length;
      if(pending>=25)aiDigest()}
    renderAiIfOpen();
    return ev
  }catch(e){return null}}

function reactNow(ev){
  const a=aiCfg();if(!a.auto.on||!aiReady())return;
  const d=ev.data||{};
  if(ev.type==='reply_triaged'&&d.gmId){
    const r=findReply(d.gmId);if(!r||!r.creatorId||r.intent==='OUT_OF_OFFICE'||r.needsReview)return;
    aiEnqueue('reply',`A creator just replied. reply_id=${r.gmId}, creator_id=${r.creatorId}, intent=${r.intent}.
Their message:
"""
${(r.body||'').slice(0,2500)}
"""
Current draft on it: ${r.aiDraft?'"""'+r.aiDraft+'"""':'none'}

Decide the next step with the tools: check their record, correct the stage if needed, save an address if they wrote one, improve the draft if it misses what they asked, then call send_reply (it files it for approval when needed). If they negotiate, draft a counter within the ceiling via propose_email and flag the reason.`,'reply:'+r.gmId)}
  if(ev.type==='discovery_done')
    aiEnqueue('discovery',`A TikTok discovery run just finished: ${num(d.kept||0)} creators kept, ${num(d.scored||0)} ranked by AI. Use query_creators (platform tiktok, sort views) and get_discovery_stats, then record_insight with how many strong fits there are, the dominant niches, and what to do next (who to queue first). No other action.`,'dx:'+d.job)
  if(ev.type==='payout')
    aiEnqueue('payout',`A payout was just settled: ${money(d.total||0)} across ${d.lines||0} creator(s) for campaign ${d.camp}. Read the campaign, then record_insight with budget used and whether the pace is on track. Take no other action.`,'pay:'+d.camp+':'+d.date)
  if(ev.type==='email_failed'){
    const recent=a.events.filter(e=>e.type==='email_failed'&&Date.now()-new Date(e.at)<DAY).length;
    if(recent>=3)aiEnqueue('bounces',`${recent} emails failed to send in the last 24 hours. Latest error: "${String(d.err||'').slice(0,200)}". Read get_metrics and the failing events with get_events type=email_failed, then record_insight (priority high) explaining the likely cause and flag_for_human with the fix. Do not change any creator.`,'bounce:'+new Date().toISOString().slice(0,13))}
  if(ev.type==='video_missing_link'&&d.id)
    aiEnqueue('compliance',`creator_id=${d.id} posted a video without the tracked link. A nudge was ${d.nudged?'already sent automatically':'NOT sent (no threaded mailbox)'}. Check their record; if no nudge went out, file one with propose_email kind=other asking them to add the link so their views count.`,'vml:'+d.id)
}

/* ── the ops agent's view of the business ───────────────────────────────── */
function pipeAll(){return Object.values(db.pipe||{})}
function lastAt(p){return p.log&&p.log[0]?new Date(p.log[0].at).getTime():0}
function daysSince(t){return t?Math.floor((Date.now()-t)/DAY):null}
function campSummary(c){
  const spent=campSpent(c),owe=campOwed(c),budget=Number(c.budget)||0;
  return {id:c.id,name:c.product||c.name||'Campaign',status:c.status||'',budget,spent:Math.round(spent),
    owed:Math.round(owe),views:campViews(c),creators:(c.creators||[]).length,videos:(c.videos||[]).length,
    budget_used_pct:budget?Math.round((spent+owe)/budget*100):null}}
function repliesFor(id){return (inboxCfg().replies||[]).filter(r=>r.creatorId===id)}
function findReply(id){return (inboxCfg().replies||[]).find(r=>r.gmId===id)}
function approvalAdd(item){
  const a=aiCfg();
  const dup=a.approvals.find(x=>x.status==='pending'&&x.type===item.type&&x.creatorId===item.creatorId&&x.kind===item.kind);
  if(dup){Object.assign(dup,item,{id:dup.id});save();renderAiBadge();return dup}
  const it={id:item.id||uid(),at:new Date().toISOString(),status:'pending',...item};
  a.approvals.unshift(it);a.approvals=a.approvals.slice(0,300);save();renderAiBadge();return it}
function insightAdd(i){
  const a=aiCfg();
  const it={id:i.id||uid(),at:i.at||new Date().toISOString(),title:String(i.title||'').slice(0,160),
    detail:String(i.detail||'').slice(0,900),category:i.category||'general',priority:i.priority||'normal',
    creatorId:i.creator_id||i.creatorId||'',source:i.source||'app'};
  if(a.insights.some(x=>x.id===it.id))return it;
  a.insights.unshift(it);a.insights=a.insights.slice(0,150);save();return it}

function metrics(){
  const now=Date.now(),sent=db.out.sent||[],reps=inboxCfg().replies||[],all=pipeAll();
  const within=(t,d)=>t&&now-new Date(t).getTime()<d*DAY;
  const ok=sent.filter(s=>s.ok),bad=sent.filter(s=>!s.ok);
  const replied=new Set(reps.map(r=>r.creatorId).filter(Boolean));
  const intents={};reps.forEach(r=>{if(r.intent)intents[r.intent]=(intents[r.intent]||0)+1});
  const reached=all.filter(p=>p.stage!=='shortlisted').length;
  const stageIdx=s=>STAGES.findIndex(x=>x[0]===s);
  const atLeast=k=>all.filter(p=>stageIdx(p.stage)>=stageIdx(k)&&p.stage!=='declined').length;
  return {sent_total:ok.length,sent_24h:ok.filter(s=>within(s.at,1)).length,sent_7d:ok.filter(s=>within(s.at,7)).length,
    failed_total:bad.length,failed_24h:bad.filter(s=>within(s.at,1)).length,
    failure_rate_pct:sent.length?Math.round(bad.length/sent.length*100):0,
    replies_total:reps.length,replies_7d:reps.filter(r=>within(r.at,7)).length,
    reply_rate_pct:ok.length?Math.round(replied.size/ok.length*100):0,intents,
    funnel:{contacted:reached,replied:atLeast('replied'),shipped:atLeast('shipped'),live:atLeast('live_pending'),
      live_confirmed:all.filter(p=>p.stage==='live_ok').length,declined:all.filter(p=>p.stage==='declined').length},
    queue:(db.out.queue||[]).length,sending:!!db.out.running,
    campaigns:(db.campaigns||[]).map(campSummary)}}

function analyticsCtx(){const sent={};(db.out.sent||[]).forEach(x=>{if(!sent[x.id])sent[x.id]=x});
  return {pipe:db.pipe||{},sent,replies:inboxCfg().replies||[],now:Date.now(),
    camps:Object.fromEntries((db.campaigns||[]).map(c=>[c.id,1]))}}

/* ── stage moves that can never go backwards by accident ─────────────────
   Triage and the agent both go through this. A creator who already has the
   product and writes "no thanks" is not silently declined: the owner decides. */
function advanceStage(p,stage,msg,{allowBackward=false,source='app'}={}){
  const why=CadenceAnalytics.stageMoveProblem(p.stage||'shortlisted',stage,allowBackward);
  if(!why){setStage(p,stage,msg);return {ok:true}}
  if(why!=='already at that stage'&&stage==='declined')
    approvalAdd({type:'todo',kind:'todo:decline-after-ship',creatorId:p.id,title:p.name||p.email,
      why:`${msg||'Declined'} — but they are at "${STAGE_LABEL(p.stage)}" and already have the product. Decide what to do.`,priority:'high'});
  return {ok:false,reason:why}}

/* ── deliveries: one record per parcel, updated from every source ───────── */
const SHIP_STATUSES=['shipped','in_transit','delivered','issue','returned'];
function updateShipment(p,{status,carrier,tracking,note,source='app'}={}){
  if(!p)return {error:'unknown creator id'};
  if(status&&!SHIP_STATUSES.includes(status))return {error:'status must be one of '+SHIP_STATUSES.join(', ')};
  const sh=p.ship||(p.ship={status:p.shippedAt?'shipped':'',carrier:'',tracking:'',deliveredAt:'',updates:[]});
  if(!sh.updates)sh.updates=[];
  if(carrier)sh.carrier=String(carrier).slice(0,40);
  if(tracking)sh.tracking=String(tracking).replace(/\s+/g,'').slice(0,60);
  const prev=sh.status;
  if(status){
    if(status==='delivered'&&!p.shippedAt){p.shippedAt=new Date().toISOString()}
    sh.status=status;if(status==='delivered'&&!sh.deliveredAt)sh.deliveredAt=new Date().toISOString()}
  sh.updates.unshift({at:new Date().toISOString(),status:sh.status,note:String(note||'').slice(0,200),source});
  sh.updates=sh.updates.slice(0,15);
  if(status&&CadenceAnalytics.STAGE_ORDER.indexOf(p.stage)<CadenceAnalytics.STAGE_ORDER.indexOf('shipped')&&p.stage!=='declined')
    setStage(p,'shipped',status==='delivered'?'Parcel delivered':'Parcel on its way');
  if(status&&status!==prev){pipeLog(p,`Delivery: ${status}${note?' — '+String(note).slice(0,80):''}`);
    emit(status==='delivered'?'delivered':status==='issue'?'delivery_issue':'shipment_updated',{id:p.id,name:p.name,status,carrier:sh.carrier,source})}
  save();return {ok:true,ship:{status:sh.status,carrier:sh.carrier,tracking:sh.tracking,deliveredAt:sh.deliveredAt}}}
function trackingUrl(sh){if(!sh||!sh.tracking)return '';
  const t=encodeURIComponent(sh.tracking),c=(sh.carrier||'').toLowerCase();
  if(/ups/.test(c))return 'https://www.ups.com/track?tracknum='+t;
  if(/fedex/.test(c))return 'https://www.fedex.com/fedextrack/?trknbr='+t;
  if(/usps/.test(c))return 'https://tools.usps.com/go/TrackConfirmAction?tLabels='+t;
  if(/dhl/.test(c))return 'https://www.dhl.com/global-en/home/tracking.html?tracking-id='+t;
  if(/royal/.test(c))return 'https://www.royalmail.com/track-your-item#/tracking-results/'+t;
  if(/colissimo|laposte|la poste/.test(c))return 'https://www.laposte.fr/outils/suivre-vos-envois?code='+t;
  return 'https://parcelsapp.com/en/tracking/'+t}
function campaignLinesFor(id){const out=[];
  for(const c of db.campaigns||[])for(const cr of c.creators||[])if(cr.pid===id){
    const vids=(c.videos||[]).filter(v=>v.cr===cr.id);
    out.push({campaign:c.id,campaign_name:c.product,rate:cr.rate,videos:vids.length,
      views:vids.reduce((a,v)=>a+v.views,0),owed:Math.round(vids.reduce((a,v)=>a+owed(c,v),0))})}
  return out}

const OPS_TOOLS={
  query_creators:{desc:CadenceAnalytics.TOOL_SCHEMAS.query_creators.description,
    schema:CadenceAnalytics.TOOL_SCHEMAS.query_creators.input_schema,
    run:f=>CadenceAnalytics.queryCreators(analyticsCtx(),f)},
  get_segments:{desc:CadenceAnalytics.TOOL_SCHEMAS.get_segments.description,
    schema:CadenceAnalytics.TOOL_SCHEMAS.get_segments.input_schema,
    run:f=>CadenceAnalytics.segments(analyticsCtx(),f)},
  audit_data:{desc:CadenceAnalytics.TOOL_SCHEMAS.audit_data.description,schema:CadenceAnalytics.TOOL_SCHEMAS.audit_data.input_schema,
    run:()=>CadenceAnalytics.audit(analyticsCtx())},
  get_shipments:{desc:CadenceAnalytics.TOOL_SCHEMAS.get_shipments.description,schema:CadenceAnalytics.TOOL_SCHEMAS.get_shipments.input_schema,
    run:f=>CadenceAnalytics.shipments(analyticsCtx(),{overdue_days:aiCfg().auto.shipCheckDays,...(f||{})})},
  update_shipment:{desc:'Record where a parcel is: carrier and tracking number, or a status change (in_transit, delivered, issue, returned) with the evidence in note. Only from something real — the creator said it arrived, a tracking page, the owner. Never guess delivery.',
    schema:{type:'object',properties:{id:{type:'string'},status:{type:'string',enum:['shipped','in_transit','delivered','issue','returned']},
      carrier:{type:'string'},tracking:{type:'string'},note:{type:'string',description:'the evidence, e.g. "creator wrote: got the box yesterday"'}},required:['id','note']},
    run:({id,status,carrier,tracking,note},ctx)=>updateShipment(db.pipe&&db.pipe[id],{status,carrier,tracking,note,source:'agent'})},
  get_overview:{desc:'Snapshot of everything right now: funnel counts by stage, who needs a human, inbox, sending queue, campaigns with budget use, pending approvals.',
    schema:{type:'object',properties:{}},
    run:()=>{
      const all=pipeAll(),box=inboxCfg();
      const byStage={};STAGES.forEach(([k])=>byStage[k]=all.filter(p=>p.stage===k).length);
      const byStatus={};(box.replies||[]).forEach(r=>byStatus[r.status]=(byStatus[r.status]||0)+1);
      return {today:new Date().toISOString().slice(0,10),creators:all.length,by_stage:byStage,
        needs_you:all.filter(needsYou).length,inbox:byStatus,
        queue:(db.out.queue||[]).length,sending:!!db.out.running,sent_total:(db.out.sent||[]).length,
        campaigns:(db.campaigns||[]).map(campSummary),
        pending_approvals:aiCfg().approvals.filter(x=>x.status==='pending').length,
        undigested_events:aiCfg().events.filter(e=>!e.digested).length,
        rate_per_1000:db.out.rate||5,max_rate_allowed:aiCfg().auto.maxRate||db.out.rate||5}}},
  get_metrics:{desc:'Performance numbers: emails sent and failed (24h, 7d), failure rate, reply rate, reply intents, funnel conversion, campaign spend and views.',
    schema:{type:'object',properties:{}},run:()=>metrics()},
  get_discovery_stats:{desc:'The lead index built by discovery: how many creators per platform and status, how many have an email.',
    schema:{type:'object',properties:{}},
    run:async()=>{const out={};
      for(const pl of ['youtube','tiktok']){const k=await idbQuery({platform:pl});
        const recs=await idbGetMany(k.slice(0,4000).map(x=>x.id));const st={};let mail=0;
        recs.forEach(r=>{st[r.status||'new']=(st[r.status||'new']||0)+1;if(r.email)mail++});
        out[pl]={total:k.length,by_status:st,with_email:mail}}
      return out}},
  get_events:{desc:'The live event stream from every feature (discovery, match, outreach, inbox, pipeline, campaigns, payouts, settings), newest first.',
    schema:{type:'object',properties:{type:{type:'string'},category:{type:'string'},since_hours:{type:'number'},
      only_undigested:{type:'boolean'},limit:{type:'integer',description:'default 40, max 150'}}},
    run:({type,category,since_hours,only_undigested,limit})=>{
      let l=aiCfg().events;
      if(type)l=l.filter(e=>e.type===type);if(category)l=l.filter(e=>e.cat===category);
      if(since_hours)l=l.filter(e=>Date.now()-new Date(e.at).getTime()<since_hours*3600000);
      if(only_undigested)l=l.filter(e=>!e.digested);
      return {total:l.length,events:l.slice(0,Math.min(limit||40,150)).map(e=>({id:e.id,at:e.at,type:e.type,category:e.cat,severity:e.sev,data:e.data}))}}},
  list_creators:{desc:'List creators in the pipeline, filtered. Returns id, name, stage, days since last event.',
    schema:{type:'object',properties:{stage:{type:'string',description:'one stage key, optional'},
      needs_you:{type:'boolean'},query:{type:'string',description:'name, email or handle contains'},
      limit:{type:'integer',description:'default 25, max 100'}}},
    run:({stage,needs_you,query,limit})=>{
      let l=pipeAll();
      if(stage)l=l.filter(p=>p.stage===stage);
      if(needs_you)l=l.filter(needsYou);
      if(query){const q=String(query).toLowerCase();l=l.filter(p=>[p.name,p.email,p.handle].join(' ').toLowerCase().includes(q))}
      return {total:l.length,creators:l.slice(0,Math.min(limit||25,100)).map(p=>({id:p.id,name:p.name,
        email:p.email,platform:p.platform,stage:p.stage,days_since_last_event:daysSince(lastAt(p)),
        has_address:!!p.addr,video:p.videoUrl||''}))}}},
  get_creator:{desc:'Everything about one creator: stage, history, address, video, discovery data, campaign views and money, every reply.',
    schema:{type:'object',properties:{id:{type:'string'}},required:['id']},
    run:async({id})=>{const p=db.pipe&&db.pipe[id];if(!p)return {error:'unknown creator id'};
      const s=(db.out.sent||[]).find(x=>x.id===id);
      let lead=null;try{const l=await idbGet(id);if(l)lead={subs:l.subs,median_views:l.medViews,country:l.country,keyword:l.kw,
        email_source:l.emailSrc,sponsors:l.catSponsored,authenticity:l.model&&l.model.auth,url:l.url}}catch(e){}
      return {...p,log:(p.log||[]).slice(0,12),first_email_at:s&&s.at||null,median_views:p.views||s&&s.views||null,
        discovery:lead,campaigns:campaignLinesFor(id),
        replies:repliesFor(id).slice(0,6).map(r=>({reply_id:r.gmId,at:r.at,intent:r.intent,status:r.status,
          body:(r.body||'').slice(0,1500),draft:r.aiDraft||''}))}}},
  list_replies:{desc:'Creator replies in the inbox, newest first.',
    schema:{type:'object',properties:{status:{type:'string',description:'new, ready, sent, skipped, error'},
      intent:{type:'string'},limit:{type:'integer'}}},
    run:({status,intent,limit})=>{let l=inboxCfg().replies||[];
      if(status)l=l.filter(r=>r.status===status);if(intent)l=l.filter(r=>r.intent===intent);
      return {total:l.length,replies:l.slice(0,Math.min(limit||20,60)).map(r=>({reply_id:r.gmId,creator_id:r.creatorId,
        name:r.name,intent:r.intent,status:r.status,at:r.at,body:(r.body||'').slice(0,600)}))}}},
  set_stage:{desc:'Move a creator to another stage, with the reason. Use only when the data clearly supports it.',
    schema:{type:'object',properties:{id:{type:'string'},stage:{type:'string',enum:STAGES.map(s=>s[0])},
      reason:{type:'string'},allow_backward:{type:'boolean',description:'only when the data proves the creator really went back'}},required:['id','stage','reason']},
    run:({id,stage,reason,allow_backward})=>{const p=db.pipe&&db.pipe[id];if(!p)return {error:'unknown creator id'};
      if(!STAGES.some(s=>s[0]===stage))return {error:'unknown stage'};
      const from=p.stage,r=advanceStage(p,stage,'AI · '+reason,{allowBackward:!!allow_backward});
      return r.ok?{ok:true,from,to:stage}:{error:r.reason}}},
  save_address:{desc:'Store a shipping address that the creator actually wrote. Never invent fields.',
    schema:{type:'object',properties:{id:{type:'string'},address:{type:'object',properties:{name:{type:'string'},
      line1:{type:'string'},line2:{type:'string'},city:{type:'string'},region:{type:'string'},postal:{type:'string'},
      country:{type:'string'}},required:['line1','city','country']}},required:['id','address']},
    run:({id,address})=>{const p=db.pipe&&db.pipe[id];if(!p)return {error:'unknown creator id'};
      if(!address||!address.line1||!address.city)return {error:'address incomplete — ask them instead'};
      p.addr={found:true,...address};setStage(p,'address_ready','AI · address saved');
      emit('address_captured',{id,by:'agent'});return {ok:true}}},
  draft_reply:{desc:'Put a reply draft on an inbox message. Does not send it.',
    schema:{type:'object',properties:{reply_id:{type:'string'},text:{type:'string'}},required:['reply_id','text']},
    run:({reply_id,text})=>{const r=findReply(reply_id);if(!r)return {error:'unknown reply id'};
      r.aiDraft=String(text).trim();if(r.status==='new'||r.status==='error')r.status='ready';save();return {ok:true}}},
  send_reply:{desc:'Send the drafted reply. Only sends immediately for categories the owner allowed on autopilot; everything else is filed for their approval automatically.',
    schema:{type:'object',properties:{reply_id:{type:'string'}},required:['reply_id']},
    run:async({reply_id})=>{const r=findReply(reply_id);if(!r)return {error:'unknown reply id'};
      if(!r.aiDraft)return {error:'no draft on this reply — call draft_reply first'};
      if(r.status==='sent')return {error:'already sent'};
      const a=aiCfg().auto;
      const canGmail=mailCfg().provider==='google'&&!r.manual;
      const allowed=canGmail&&a.on&&!r.needsReview&&a.autoSend.includes(r.intent)&&!['NEGOTIATE','DECLINE'].includes(r.intent);
      if(!allowed){approvalAdd({type:'reply',kind:'reply',creatorId:r.creatorId,replyId:r.gmId,
          title:`Reply to ${r.name||r.email}`,why:`${r.intent||'Reply'} — needs your eyes before it goes`,
          to:r.email,subject:/^re:/i.test(r.subject||'')?r.subject:'Re: '+(r.subject||db.out.subject||''),body:r.aiDraft,threadId:r.threadId||''});
        return {queued_for_approval:true}}
      await sendReply(r,true);return {sent:r.status==='sent',error:r.err||undefined}}},
  propose_email:{desc:'File an email (follow-up, reminder, counter-offer) for the owner to approve. It is never sent without approval.',
    schema:{type:'object',properties:{creator_id:{type:'string'},kind:{type:'string',enum:['follow_up','video_reminder','delivery_check','counter_offer','address_request','thanks','other']},
      subject:{type:'string'},body:{type:'string'},reason:{type:'string'}},required:['creator_id','kind','body','reason']},
    run:({creator_id,kind,subject,body,reason})=>{const p=db.pipe&&db.pipe[creator_id];if(!p)return {error:'unknown creator id'};
      if(!p.email)return {error:'no email for this creator'};
      const bad=rateOverCeiling(body);if(bad)return {error:bad};
      const s=(db.out.sent||[]).find(x=>x.id===creator_id);
      const it=approvalAdd({type:'email',kind,creatorId:creator_id,title:`${kind.replace('_',' ')} → ${p.name||p.email}`,
        why:reason,to:p.email,subject:subject||'Re: '+(db.out.subject||'our note'),body,threadId:s&&s.gmThreadId||''});
      return {queued_for_approval:true,approval_id:it.id}}},
  check_video:{desc:'Re-check a creator\'s posted video for the brand link in the description.',
    schema:{type:'object',properties:{id:{type:'string'}},required:['id']},
    run:async({id})=>{const p=db.pipe&&db.pipe[id];if(!p)return {error:'unknown creator id'};
      if(!p.videoUrl)return {error:'no video link stored'};await checkCompliance(p,true);return {stage:p.stage}}},
  flag_for_human:{desc:'Put something on the owner\'s to-do list when only a person can decide.',
    schema:{type:'object',properties:{creator_id:{type:'string'},reason:{type:'string'},
      priority:{type:'string',enum:['high','normal','low']}},required:['reason']},
    run:({creator_id,reason,priority})=>{const p=creator_id&&db.pipe&&db.pipe[creator_id];
      approvalAdd({type:'todo',kind:'todo:'+String(reason).slice(0,40),creatorId:creator_id||'',
        title:p?`${p.name||p.email}`:'General',why:reason,priority:priority||'normal'});return {ok:true}}},
  record_insight:{desc:'Write down something the owner should know: a pattern, a risk, a win, a number that moved. Shows in the insight feed. Use for observations, not for tasks.',
    schema:{type:'object',properties:{title:{type:'string'},detail:{type:'string'},
      category:{type:'string',enum:['discovery','outreach','inbox','pipeline','compliance','campaign','money','deliverability','general']},
      priority:{type:'string',enum:['high','normal','low']},creator_id:{type:'string'}},required:['title','category']},
    run:(i)=>{const it=insightAdd({...i,source:'agent'});return {ok:true,id:it.id}}},
  get_campaign:{desc:'One campaign: budget, spent, owed now, views, per-creator amounts.',
    schema:{type:'object',properties:{id:{type:'string'}},required:['id']},
    run:({id})=>{const c=(db.campaigns||[]).find(x=>x.id===id);if(!c)return {error:'unknown campaign'};
      return {...campSummary(c),lines:(c.creators||[]).map(cr=>({name:cr.name,rate:cr.rate,
        views:c.videos.filter(v=>v.cr===cr.id).reduce((a,v)=>a+v.views,0),
        owed:Math.round(c.videos.filter(v=>v.cr===cr.id).reduce((a,v)=>a+owed(c,v),0))}))}}},
  get_lists:{desc:'Every saved discovery list: name, how many creators, when saved, its AI summary, and a category breakdown (how many creators in each niche/tier). Use this before answering anything about who was found in Discover.',
    schema:{type:'object',properties:{}},
    run:()=>({total:(db.lists||[]).length,lists:(db.lists||[]).map(l=>{
      const by={};(l.items||[]).forEach(it=>{const k=it.category||'(unclassified)';by[k]=(by[k]||0)+1});
      return {id:l.id,name:l.name,count:l.items?l.items.length:0,createdAt:l.createdAt,summary:l.summary||'',
        note:l.note||'',by_category:by}})}) },
  get_list:{desc:'One saved discovery list with every creator in it: name, handle, platform, subs, median views, category, tier.',
    schema:{type:'object',properties:{id:{type:'string'}},required:['id']},
    run:({id})=>{const l=(db.lists||[]).find(x=>x.id===id);if(!l)return {error:'unknown list id'};
      return {id:l.id,name:l.name,note:l.note||'',summary:l.summary||'',createdAt:l.createdAt,
        items:(l.items||[]).map(it=>({id:it.id,name:it.name,handle:it.handle,platform:it.platform,
          subs:it.subs,medViews:it.medViews,country:it.country,category:it.category||'',tier:it.tier||'',
          email:it.email?1:0}))}}},
};
const OPS_TOOL_DEFS=()=>Object.entries(OPS_TOOLS).map(([name,t])=>({name,description:t.desc,input_schema:t.schema}));

function rateOverCeiling(body){
  const cap=aiCfg().auto.maxRate||db.out.rate||5;
  const PER='\\s*(?:per|\\/|a|les|pour|par)\\s*(?:1[ ,.\\u202f]?000|thousand|1k|mille)';
  const rates=[...String(body).matchAll(new RegExp('[$€]\\s?(\\d+(?:[.,]\\d+)?)'+PER+'|(\\d+(?:[.,]\\d+)?)\\s?(?:\\$|€|dollars?|euros?)'+PER,'gi'))]
    .map(m=>parseFloat((m[1]||m[2]).replace(',','.')));
  return rates.some(x=>x>cap)?`rate above the ceiling of $${cap} per 1,000 views — rewrite within it`:''}

function opsSystem(){
  const a=aiCfg().auto,rate=db.out.rate||5,cap=a.maxRate||rate;
  return `You are the operations brain of Cadence, a platform that runs creator campaigns paid per verified view. Every feature reports to you: discovery (leads found), match (rosters), outreach (queue, sends, failures), the inbox (creator replies), the pipeline (each creator's stage), campaigns (videos, views, budgets) and payouts. You have tools over all of that live data. Always read before you act — call a tool rather than guessing.

${brandBrief()}

${CadenceAnalytics.DATA_MODEL}

Hard rules (the tools enforce them too):
- The offer is $${rate} per 1,000 verified views, paid weekly. Never propose more than $${cap} per 1,000 views, never a flat fee, never a guaranteed minimum.
- Money, negotiation and refusals are decided by the owner: counter-offers and anything touching the rate go through propose_email, which files them for approval.
- Never invent a fact about a creator, an address, a view count or a date. If data is missing, say so or ask the creator.
- Creator-facing emails: plain, under 110 words, no marketing tone, no exclamation marks, signed with ${db.out.fromName||'the sender'}'s first name, in the creator's language.
- One action per creator per situation. Do not repeat an action already in their history.
- Observations go to record_insight, decisions only a person can make go to flag_for_human. Don't do both for the same thing.
- Counting and classifying: never estimate. Numbers come from query_creators, get_segments, get_metrics, get_shipments or audit_data — they run over every record. If a tool says a reply needs review, do not act on its intent until the owner has.
- Deliveries: a parcel is delivered only when the creator or the owner says so, or a tracking page shows it. Record it with update_shipment and the evidence.
${aiCfg().memory?'\nWhat the owner told you in earlier conversations (keep applying it):\n'+aiCfg().memory+'\n':''}
When you talk to the owner: answer in the language they wrote in (usually French), short, numbers first, and end with what you did and what still needs them.`}

async function opsRun(prompt,{history=[],maxSteps=8,source='chat'}={}){
  const messages=[...history,{role:'user',content:prompt}];
  const actions=[];let finalText='';
  for(let step=0;step<maxSteps;step++){
    const j=await claudeCall({max_tokens:1600,system:sys(opsSystem()),tools:OPS_TOOL_DEFS(),messages});
    messages.push({role:'assistant',content:j.content});
    const uses=(j.content||[]).filter(b=>b.type==='tool_use');
    finalText=textOf(j)||finalText;
    if(j.stop_reason!=='tool_use'||!uses.length)break;
    const results=[];
    for(const u of uses){
      const t=OPS_TOOLS[u.name];let out;
      try{out=t?await t.run(u.input||{},{source}):{error:'unknown tool'}}catch(e){out={error:e.message}}
      if(out===undefined)out={ok:true};
      actions.push({tool:u.name,input:u.input,out});
      results.push({type:'tool_result',tool_use_id:u.id,content:JSON.stringify(out).slice(0,9000),
        ...(out&&out.error?{is_error:true}:{})});
    }
    messages.push({role:'user',content:results});
  }
  const writes=actions.filter(x=>!/^(get_|list_)/.test(x.tool)&&!(x.out&&x.out.error));
  if(source!=='chat'&&writes.length)opsLog(`Copilot (${source}) — ${finalText.split('\n')[0].slice(0,220)||writes.map(w=>w.tool).join(', ')}`);
  return {text:finalText,actions,messages}}

/* ── jobs: one at a time, deduplicated ─────────────────────────────────── */
const aiJobs=[];let aiJobBusy=false;
function aiEnqueue(source,prompt,key){
  if(key&&aiJobs.some(j=>j.key===key))return;
  aiJobs.push({source,prompt,key});aiPump()}
async function aiPump(){
  if(aiJobBusy||!aiJobs.length)return;
  aiJobBusy=true;const job=aiJobs.shift();
  try{await opsRun(job.prompt,{source:job.source,maxSteps:job.source==='digest'?10:6})}
  catch(e){opsLog(`Copilot could not handle ${job.source}: ${e.message}`)}
  aiJobBusy=false;renderAiIfOpen();renderPipeBadge();aiPump()}
const aiIdle=async()=>{while(aiJobBusy||aiJobs.length)await sleep(5)};

/* compat: older call sites */
function aiEmit(type,data){
  if(type==='reply_triaged'&&data&&data.rep)return emit('reply_triaged',{gmId:data.rep.gmId,creatorId:data.rep.creatorId,intent:data.rep.intent});
  if(type==='payout')return emit('payout',data);
  return emit(type,data)}

/* ── digest: Sonnet reads the batched stream together ─────────────────── */
function aiDigest(force){
  const a=aiCfg();if(!a.auto.on||!aiReady())return 0;
  const pend=a.events.filter(e=>!e.digested);
  if(!pend.length)return 0;
  if(!force&&pend.length<25&&Date.now()-(a.lastDigest||0)<a.auto.digestEveryMin*60000)return 0;
  if(aiJobs.some(j=>j.source==='digest'))return 0;
  const batch=pend.slice(0,80);batch.forEach(e=>e.digested=true);a.lastDigest=Date.now();save();
  const lines=batch.slice().reverse().map(e=>`${e.at.slice(5,16).replace('T',' ')} ${e.type} [${e.cat}${e.sev!=='info'?'/'+e.sev:''}] ${JSON.stringify(e.data).slice(0,220)}`).join('\n');
  aiEnqueue('digest',`Here is everything that happened in the app since the last digest (${batch.length} events, oldest first):
${lines}

1. Classify the stream: what matters, what is routine. 2. Look for patterns worth the owner's attention — a reply rate moving, failures piling up, a campaign's views jumping or stalling, a discovery run that found nothing, creators stuck at a stage. Use get_metrics / get_overview to confirm with numbers before you conclude. 3. Act where the tools let you (stage fixes backed by data, emails for approval). 4. Record at most 3 insights, only ones that change what the owner should do — routine activity gets none. End with one sentence summarising the period.`,'digest:'+batch[0].id);
  return batch.length}

/* ── scanner: finds situations nobody reported, spends nothing when none ── */
function aiScan(force){
  const a=aiCfg();if(!a.auto.on||!aiReady())return 0;
  if(!force&&Date.now()-a.auto.lastScan<a.auto.scanEveryMin*60000)return 0;
  a.auto.lastScan=Date.now();
  let n=0;const now=Date.now();
  /* indexes built once: the scan stays linear at tens of thousands of creators */
  const sentBy={};for(const x of db.out.sent||[])if(!sentBy[x.id])sentBy[x.id]=x;
  const repliedIds=new Set((inboxCfg().replies||[]).map(r=>r.creatorId).filter(Boolean));
  for(const p of pipeAll()){
    const f=a.flags[p.id]||(a.flags[p.id]={});
    const s=sentBy[p.id];
    const sh=p.ship||{},shipped=!!p.shippedAt,delivered=sh.status==='delivered';
    if(shipped&&!delivered&&sh.status!=='issue'&&sh.status!=='returned'&&!p.videoUrl&&!f.shipCheck
       &&now-new Date(p.shippedAt).getTime()>a.auto.shipCheckDays*DAY&&['shipped','live_pending'].includes(p.stage)){
      f.shipCheck=now;n++;
      aiEnqueue('delivery-check',`creator_id=${p.id} was shipped the product ${daysSince(new Date(p.shippedAt).getTime())} days ago and nobody has confirmed delivery${sh.tracking?` (tracking ${sh.tracking}${sh.carrier?' via '+sh.carrier:''})`:''}. Read their record and replies: if a reply already says it arrived, call update_shipment status=delivered with that quote as note. Otherwise file ONE short check-in with propose_email kind=delivery_check asking whether the box arrived.`,'sc:'+p.id)}
    if(p.stage==='contacted'&&s&&s.ok&&!f.followUp&&now-new Date(s.at).getTime()>a.auto.followUpDays*DAY
       &&!repliedIds.has(p.id)){
      f.followUp=now;n++;
      aiEnqueue('follow-up',`creator_id=${p.id} got our first email ${daysSince(new Date(s.at).getTime())} days ago and never replied. Write one short, low-pressure follow-up (under 60 words, no guilt, restate the number) and file it with propose_email kind=follow_up. Only one follow-up ever.`,'fu:'+p.id)}
    const since=delivered&&sh.deliveredAt?new Date(sh.deliveredAt).getTime():p.shippedAt?new Date(p.shippedAt).getTime():0;
    const wait=(delivered?a.auto.videoAfterDeliveryDays:a.auto.remindDays)*DAY;
    if(p.stage==='shipped'&&!p.videoUrl&&since&&!f.remind&&now-since>wait){
      f.remind=now;n++;
      aiEnqueue('video-reminder',`creator_id=${p.id} ${delivered?'has had the product (delivery confirmed)':'was shipped the product'} ${daysSince(since)} days ago and no video is logged. Check their record, then file a friendly reminder with propose_email kind=video_reminder asking if the box arrived and when they plan to post.`,'rm:'+p.id)}
    if(p.stage==='negotiating'&&!f.negFlag&&now-lastAt(p)>2*DAY){
      f.negFlag=now;n++;
      aiEnqueue('stalled-negotiation',`creator_id=${p.id} has been in negotiation for ${daysSince(lastAt(p))} days with no move. Read their replies and flag_for_human with a one-line recommendation (accept within ceiling / hold / drop).`,'ng:'+p.id)}
  }
  for(const c of db.campaigns||[]){
    const s=campSummary(c),f=a.flags['camp:'+c.id]||(a.flags['camp:'+c.id]={});
    const band=Math.floor((s.budget_used_pct||0)/5);
    if(s.budget&&s.budget_used_pct>=a.auto.budgetAlert*100&&f.alertAt!==band){
      f.alertAt=band;n++;
      aiEnqueue('budget',`Campaign ${c.id} is at ${s.budget_used_pct}% of its budget (${money(s.spent+s.owed)} of ${money(s.budget)}). Read it, then flag_for_human with priority high and a one-line recommendation: pause new outreach, raise the cap, or let it run.`,'bd:'+c.id)}
  }
  save();return n}

/* ── supervisor: once a day, the whole operation checked end to end ─────
   Plain code first (audit + shipments + metrics, exact over every record),
   then Sonnet reads the result, fixes what the tools allow and writes the
   daily brief. Runs here while the app is open and on the server by cron. */
function aiSupervise(force){
  const a=aiCfg();if(!aiReady())return false;if(!force&&!a.auto.on)return false;
  const today=new Date().toISOString().slice(0,10);
  if(!force&&a.auto.lastSupervise===today)return false;
  if(aiJobs.some(j=>j.source==='supervisor'))return false;
  a.auto.lastSupervise=today;save();
  const ctx=analyticsCtx(),au=CadenceAnalytics.audit(ctx),sh=CadenceAnalytics.shipments(ctx,{overdue_days:a.auto.shipCheckDays,limit:10});
  const m=metrics();
  const issues=au.issues.map(i=>`- ${i.check} [${i.severity}] ×${i.count}: ${JSON.stringify(i.examples.slice(0,5))}`).join('\n')||'- none';
  aiEnqueue('supervisor',`Daily supervision, ${today}. Everything below was computed in code over all ${num(au.creators)} creators and ${num(au.replies)} replies — it is exact.

DATA AUDIT (${au.issues_total} problem(s)):
${issues}

DELIVERIES: ${JSON.stringify({total:sh.total,by_status:sh.by_status,overdue_in_transit:sh.overdue_in_transit,delivered_no_video:sh.delivered_no_video,issues:sh.issues})}
Overdue: ${JSON.stringify(sh.overdue.map(x=>({id:x.id,name:x.name,days:x.days_since_shipped,tracking:x.tracking})))}

METRICS: ${JSON.stringify({sent_7d:m.sent_7d,failed_24h:m.failed_24h,failure_rate_pct:m.failure_rate_pct,reply_rate_pct:m.reply_rate_pct,replies_7d:m.replies_7d,funnel:m.funnel,queue:m.queue,campaigns:m.campaigns.map(c=>({name:c.name,used:c.budget_used_pct}))})}

Your job:
1. Fix what the data proves and the tools allow (a stage that contradicts the record, a delivery a reply already confirms). Read the record before each fix. Never invent the missing data — ask for it via propose_email or flag it.
2. flag_for_human once for each high-severity problem you cannot fix, with the exact creators.
3. record_insight titled "Daily brief" (category general): the 3–5 numbers that matter, what is blocked and where, deliveries, and the first 3 things the owner should do today.
End with one line.`,'sup:'+today);
  return true}

/* ═══ SYNC — the backend keeps a copy and works while this tab is closed ═══ */
function hashStr(s){let h=5381;for(let i=0;i<s.length;i++)h=((h<<5)+h+s.charCodeAt(i))|0;return (h>>>0).toString(36)+s.length.toString(36)}
function syncCollections(){
  const trimReply=r=>({gmId:r.gmId,creatorId:r.creatorId,name:r.name,email:r.email,subject:r.subject,
    body:(r.body||'').slice(0,1500),intent:r.intent,status:r.status,at:r.at,aiDraft:(r.aiDraft||'').slice(0,1200),manual:!!r.manual,threadId:r.threadId||''});
  const trimSent=s=>({id:s.id,name:s.name,email:s.email,views:s.views,at:s.at,ok:s.ok,err:s.err||'',gmThreadId:s.gmThreadId||''});
  const campRec=c=>({...campSummary(c),rate:c.rate,
    lines:(c.creators||[]).map(cr=>({id:cr.id,pid:cr.pid||'',name:cr.name,rate:cr.rate,
      views:(c.videos||[]).filter(v=>v.cr===cr.id).reduce((a,v)=>a+v.views,0)}))});
  const trimListItem=l=>({id:l.id,name:l.name||'',handle:l.handle||'',platform:l.platform||'',email:l.email?1:0,
    subs:l.subs||0,medViews:l.medViews||0,country:l.country||'',category:l.category||'',tier:l.tier||''});
  const trimList=l=>({id:l.id,name:l.name,note:l.note||'',tags:l.tags||[],summary:l.summary||'',
    source:l.source||'',createdAt:l.createdAt,updatedAt:l.updatedAt,count:l.items?l.items.length:(l.count||0),
    items:(l.items||[]).slice(0,200).map(trimListItem)});
  return {pipe:Object.fromEntries(pipeAll().map(p=>[p.id,{...p,log:(p.log||[]).slice(0,10)}])),
    reply:Object.fromEntries((inboxCfg().replies||[]).map(r=>[r.gmId,trimReply(r)])),
    sent:Object.fromEntries((db.out.sent||[]).map(s=>[s.id,trimSent(s)])),
    camp:Object.fromEntries((db.campaigns||[]).map(c=>[c.id,campRec(c)])),
    list:Object.fromEntries((db.lists||[]).map(l=>[l.id,trimList(l)]))}}

let syncBusy=false;
async function syncNow(){
  const a=aiCfg();
  if(syncBusy||!a.backend.storage)return {skipped:true};
  syncBusy=true;
  try{
    const cols=syncCollections(),records={},removed={};let budget=1000;
    const seen=new Set();
    for(const [coll,recs] of Object.entries(cols)){
      for(const [id,rec] of Object.entries(recs)){
        const k=coll+':'+id;seen.add(k);
        const h=hashStr(JSON.stringify(rec));
        if(a.sync.hashes[k]!==h&&budget>0){(records[coll]||(records[coll]={}))[id]=rec;budget--}}}
    for(const k of Object.keys(a.sync.hashes))if(!seen.has(k)){const [coll,...id]=k.split(':');(removed[coll]||(removed[coll]=[])).push(id.join(':'))}
    const events=a.events.filter(e=>!e.synced).slice(0,200);
    const meta={brand:db.brand?{product:db.brand.product,price:db.brand.price,url:db.brand.url,market:db.brand.market}:{},
      out:{rate:db.out.rate,fromName:db.out.fromName,fromEmail:db.out.fromEmail,subject:db.out.subject},
      auto:{on:a.auto.on,followUpDays:a.auto.followUpDays,remindDays:a.auto.remindDays,budgetAlert:a.auto.budgetAlert,maxRate:a.auto.maxRate,
        shipCheckDays:a.auto.shipCheckDays,videoAfterDeliveryDays:a.auto.videoAfterDeliveryDays},
      flags:a.flags,stages:STAGES.map(s=>s[0])};
    const ack=a.sync.ack.slice();
    const r=await apiFetch('/api/sync',{method:'POST',body:JSON.stringify({records,removed,events,meta,ack})});
    const j=await r.json();
    if(j.error)throw new Error(j.error.message||'sync failed');
    for(const [coll,recs] of Object.entries(records))for(const [id,rec] of Object.entries(recs))a.sync.hashes[coll+':'+id]=hashStr(JSON.stringify(rec));
    for(const [coll,ids] of Object.entries(removed))ids.forEach(id=>delete a.sync.hashes[coll+':'+id]);
    events.forEach(e=>e.synced=true);
    a.sync.ack=a.sync.ack.filter(id=>!ack.includes(id));
    const applied=[];for(const op of j.ops||[]){try{applyOp(op)}catch(e){}applied.push(op.id)}
    a.sync.ack.push(...applied);
    a.sync.lastAt=Date.now();a.sync.err='';a.backend.storage=j.storage!==false;
    save();if(applied.length){renderAiIfOpen();renderPipeBadge();renderAiBadge()}
    return {pushed:Object.values(records).reduce((x,o)=>x+Object.keys(o).length,0),events:events.length,ops:applied.length}
  }catch(e){a.sync.err=e.message;save();return {error:e.message}}
  finally{syncBusy=false}}

/* Operations the backend agent produced while this tab was closed. */
function applyOp(op){
  const a=aiCfg();
  if(op.type==='set_stage'){const p=db.pipe&&db.pipe[op.id];if(p)setStage(p,op.stage,'AI (server) · '+(op.reason||''))}
  else if(op.type==='save_address'){const p=db.pipe&&db.pipe[op.id];if(p&&op.address){p.addr={found:true,...op.address};setStage(p,'address_ready','AI (server) · address saved')}}
  else if(op.type==='approval'){if(!a.approvals.some(x=>x.id===op.item.id))approvalAdd({...op.item,source:'server'})}
  else if(op.type==='insight'){insightAdd({...op.item,source:'server'})}
  else if(op.type==='ship'){const p=db.pipe&&db.pipe[op.id];if(p)updateShipment(p,{status:op.status,carrier:op.carrier,tracking:op.tracking,note:op.note,source:'server'})}
  else if(op.type==='log'){opsLog('Server agent — '+op.msg)}
  else if(op.type==='flags'){for(const [k,v] of Object.entries(op.flags||{}))a.flags[k]={...(a.flags[k]||{}),...v}}
  save()}

async function runServerAgent(){
  const r=await apiFetch('/api/agent',{method:'POST',body:JSON.stringify({source:'manual'})});
  const j=await r.json();if(j.error)throw new Error(j.error.message);
  await syncNow();return j}

/* ── manual inbox: replies that arrived outside Gmail ─────────────────── */
async function addManualReply(creatorId,text){
  text=(text||'').trim();if(!text)return null;
  const p=db.pipe&&db.pipe[creatorId];
  const s=(db.out.sent||[]).find(x=>x.id===creatorId)||{};
  const rep={gmId:'man_'+uid(),threadId:s.gmThreadId||'',creatorId:creatorId||'',manual:true,
    name:p?p.name:'',email:p?p.email:'',from:p?p.email:'',subject:'Re: '+(db.out.subject||'our note'),
    body:text.slice(0,4000),at:new Date().toISOString(),status:'new',intent:'',aiDraft:'',err:''};
  inboxCfg().replies.unshift(rep);save();
  emit('manual_reply',{gmId:rep.gmId,creatorId});
  if(aiReady())await triageReply(rep);
  return rep}

/* ── approvals: the only door through which the AI's words reach a creator ─ */
async function sendThreaded(to,subject,body,threadId){
  const m=mailCfg();
  if(m.provider==='google'&&m.tok&&await ensureToken()){
    const raw=rawMail(to,subject,body,db.out.fromEmail,db.out.fromName,db.out.replyTo);
    const r=await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
      {method:'POST',headers:{Authorization:'Bearer '+m.tok.access,'Content-Type':'application/json'},
       body:JSON.stringify(threadId?{raw,threadId}:{raw})});
    const j=await r.json();if(j.error)throw new Error(j.error.message);return 'sent'}
  window.open(`mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`);
  return 'opened'}

async function approve(id){
  const it=aiCfg().approvals.find(x=>x.id===id);if(!it)return;
  const ta=$('ap-b-'+id);if(ta)it.body=ta.value;
  try{
    if(it.type==='reply'){const r=findReply(it.replyId);if(!r)throw new Error('reply not found');
      r.aiDraft=it.body;
      if(mailCfg().provider==='google'&&!r.manual){await sendReply(r,true);if(r.status!=='sent')throw new Error(r.err||'not sent')}
      else{await sendThreaded(it.to||r.email,it.subject,it.body,'');r.status='sent'}}
    else if(it.type==='email'){await sendThreaded(it.to,it.subject,it.body,it.threadId);
      const p=db.pipe&&db.pipe[it.creatorId];if(p)pipeLog(p,`Sent ${it.kind.replace('_',' ')} (approved)`)}
    it.status='done';it.doneAt=new Date().toISOString();it.err='';
    emit('approval_decided',{id,decision:'approved',type:it.type,kind:it.kind,creatorId:it.creatorId||''});
  }catch(e){it.err=e.message}
  save();renderAi()}
function rejectAp(id){const it=aiCfg().approvals.find(x=>x.id===id);if(it){it.status='rejected';
  emit('approval_decided',{id,decision:it.type==='todo'?'done':'rejected',type:it.type,kind:it.kind,creatorId:it.creatorId||''});save();renderAi()}}

/* ── UI ─────────────────────────────────────────────────────────────────── */
function renderAiBadge(){const b=typeof document!=='undefined'&&$('aiBadge');if(!b)return;
  const n=aiCfg().approvals.filter(x=>x.status==='pending').length;
  b.innerHTML=n?` <span class="pill" style="font-size:11px;padding:1px 6px">${num(n)}</span>`:''}
function renderAiIfOpen(){const v=typeof document!=='undefined'&&$('v-ai');if(v&&v.classList.contains('on'))renderAi()}
let aiChatBusy=false;
const PRI={high:'background:var(--rust-l);border-color:var(--rust-b);color:var(--rust-d)',normal:'',low:'opacity:.7'};

function renderAi(){
  const a=aiCfg(),au=a.auto,b=a.backend,pend=a.approvals.filter(x=>x.status==='pending'),u=a.usage;
  const cost=(u.inTok*3+u.outTok*15)/1e6;
  const pipeOpts=pipeAll().filter(p=>p.stage!=='shortlisted').sort((x,y)=>(x.name||'').localeCompare(y.name||''))
    .map(p=>`<option value="${esc(p.id)}">${esc(p.name||p.email)} · ${esc(STAGE_LABEL(p.stage))}</option>`).join('');
  const undig=a.events.filter(e=>!e.digested).length;
  $('aiBody').innerHTML=`
  <div class="setup"><div class="suh"><div><b>Sonnet · ${esc(AI_MODEL)}</b>
      <span>${num(u.calls)} calls · ~$${cost.toFixed(2)} spent${u.errors?` · ${num(u.errors)} errors`:''}</span></div>
    <span class="pill ${au.on?'g':''}">${au.on?'Autopilot on':'Autopilot off'}</span></div>
    <div class="su ${b.key?'done':''}"><div class="sunum">${b.key?'✓':'1'}</div><div class="sut"><b>Model key — held by the server</b>
      <span>${!b.checked?'Checking…':b.key?'ANTHROPIC_API_KEY is set on the backend. It never reaches this page.'
        :esc(b.err||'Not connected')+' Add it in Vercel → cadence-app → Settings → Environment Variables, then redeploy.'}</span></div>
      <button class="btn sm gh" onclick="checkBackend()">Re-check</button></div>
    <div class="su ${b.storage?'done':''}"><div class="sunum">${b.storage?'✓':'2'}</div><div class="sut"><b>Server memory — runs while this tab is closed</b>
      <span>${b.storage?`Connected. Last sync ${a.sync.lastAt?new Date(a.sync.lastAt).toLocaleTimeString():'never'}${a.sync.err?' · '+esc(a.sync.err):''}.`
        :'Not connected — the agent only works while the app is open. Add Upstash Redis from Vercel Marketplace (Storage tab) to cadence-app.'}</span></div>
      ${b.storage?`<button class="btn sm" onclick="syncNow().then(renderAi)">Sync</button><button class="btn sm" ${aiReady()?'':'disabled'} onclick="this.disabled=true;runServerAgent().then(()=>renderAi(),e=>{alert(e.message);renderAi()})">Run server agent</button>`:''}</div>
    ${b.codeRequired?`<div class="su"><div class="sut"><b>Access code</b><span>This backend asks for a code before it answers.</span></div>
      <input type="password" style="max-width:220px" placeholder="${a.code?'•••• saved':'code'}" onchange="aiCfg().code=this.value.trim();save();checkBackend()"></div>`:''}
    <div class="su"><div class="sut"><b>Data</b><span>${(()=>{const t=stateStats();return `${num(t.creators)} creators · ${num(t.sent)} emails · ${num(t.replies)} replies · ${num(t.events)} events — stored in ${t.mode}${t.warn?' · <b>'+esc(t.warn)+'</b>':''}`})()}</span></div></div>
    <div class="su"><div class="sut"><b>Autopilot</b><span>Reacts to every feature as it reports: replies, failures, stage moves, videos, views, budgets. Nothing that commits money goes out without you.</span></div>
      <button class="btn sm ${au.on?'':'p'}" ${aiReady()?'':'disabled'} onclick="aiCfg().auto.on=!aiCfg().auto.on;save();if(aiCfg().auto.on){aiScan(true);aiDigest(true)}renderAi()">${au.on?'Turn off':'Turn on'}</button></div>
    <div class="su"><div class="sut"><b>Rules</b><span>Follow-up after (days) · video reminder after (days) · rate ceiling ($ / 1,000 views)</span></div>
      <div style="display:flex;gap:6px">
        <input type="number" min="1" style="width:62px" value="${au.followUpDays}" title="Follow-up days" onchange="aiCfg().auto.followUpDays=+this.value||5;save()">
        <input type="number" min="1" style="width:62px" value="${au.remindDays}" title="Reminder days" onchange="aiCfg().auto.remindDays=+this.value||14;save()">
        <input type="number" step="0.5" min="1" style="width:70px" value="${au.maxRate||db.out.rate||5}" title="Rate ceiling" onchange="aiCfg().auto.maxRate=+this.value||null;save()"></div></div>
    <div class="su"><div class="sut"><b>Deliveries</b><span>Ask whether the box arrived after (days in transit) · video reminder after delivery (days)</span></div>
      <div style="display:flex;gap:6px">
        <input type="number" min="1" style="width:62px" value="${au.shipCheckDays}" title="Delivery check days" onchange="aiCfg().auto.shipCheckDays=+this.value||7;save()">
        <input type="number" min="1" style="width:62px" value="${au.videoAfterDeliveryDays}" title="Video reminder after delivery" onchange="aiCfg().auto.videoAfterDeliveryDays=+this.value||7;save()"></div></div>
    ${a.memory?`<div class="su"><div class="sut"><b>Copilot memory</b><span style="white-space:pre-wrap">${esc(a.memory)}</span></div>
      <button class="btn sm gh" onclick="aiCfg().memory='';save();renderAi()">Forget</button></div>`:''}
  </div>

  <div class="sec"><div class="sh"><h2>Needs your OK${pend.length?` · ${num(pend.length)}`:''}</h2>
    <div style="display:flex;gap:6px"><button class="btn sm" ${aiReady()?'':'disabled'} onclick="aiSupervise(true);renderAi()" title="Audit every record, check deliveries, fix what it can and write the daily brief">Supervise now</button>
    <button class="btn sm" ${aiReady()&&au.on?'':'disabled'} onclick="aiScan(true);aiDigest(true);renderAi()">Scan now</button></div></div>
    ${(()=>{const x=CadenceAnalytics.audit(analyticsCtx());return x.clean?'':`<div class="card" style="padding:12px 16px"><b style="font-weight:500">Data check · ${num(x.issues_total)} problem(s)</b>
      <div class="hd">${x.issues.slice(0,6).map(i=>`${esc(i.check.replace(/_/g,' '))} ×${num(i.count)}`).join(' · ')}</div></div>`})()}
    ${pend.length?pend.slice(0,40).map(it=>`<div class="card" style="padding:16px 18px">
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap">
        <div><b style="font-weight:500">${esc(it.title||'')}</b> <span class="tag">${esc(it.type)}</span>${it.source==='server'?' <span class="tag">server</span>':''}
          ${it.priority==='high'?`<span class="pill" style="${PRI.high}">high</span>`:''}
          <div class="hd">${esc(it.why||'')}</div></div>
        <div style="display:flex;gap:6px">${it.type==='todo'
          ?`<button class="btn sm" onclick="rejectAp('${it.id}')">Done</button>`
          :`<button class="btn sm gh" onclick="rejectAp('${it.id}')">Reject</button><button class="btn sm p" onclick="approve('${it.id}')">Approve & send</button>`}</div></div>
      ${it.body?`<textarea id="ap-b-${it.id}" style="min-height:110px;margin-top:10px">${esc(it.body)}</textarea>`:''}
      ${it.err?`<div class="warn">${esc(it.err)}</div>`:''}</div>`).join('')
    :`<div class="card"><div class="empty" style="padding:22px">Nothing waiting on you.</div></div>`}</div>

  <div class="sec"><div class="sh"><h2>What the agent noticed</h2>
    ${a.insights.length?`<button class="btn sm gh" onclick="aiCfg().insights=[];save();renderAi()">Clear</button>`:''}</div>
    <div class="card hist">${a.insights.slice(0,25).map(i=>`<div class="h" style="display:block">
      <div style="display:flex;justify-content:space-between;gap:10px"><b style="font-weight:500">${esc(i.title)}</b>
        <span><span class="tag">${esc(i.category)}</span>${i.priority!=='normal'?` <span class="pill" style="${PRI[i.priority]||''}">${esc(i.priority)}</span>`:''}</span></div>
      ${i.detail?`<div class="hd" style="margin-top:3px">${esc(i.detail)}</div>`:''}
      <div class="hd" style="font-size:11px">${new Date(i.at).toLocaleString()}${i.source==='server'?' · server':''}</div></div>`).join('')
      ||'<div class="hd">Nothing yet — insights appear as the agent reads the stream.</div>'}</div></div>

  <div class="sec"><div class="sh"><h2>Ask Copilot</h2>
    <div style="display:flex;gap:6px"><button class="btn sm" ${aiReady()?'':'disabled'} onclick="aiAsk('Fais-moi le brief du jour : chiffres clés, ce qui bloque, et les 5 actions à faire maintenant.')">Daily brief</button>
    <button class="btn sm gh" onclick="const o=aiCfg().chat.slice();aiCfg().chat=[];save();renderAi();if(o.length>2)chatRemember(o)">Clear</button></div></div>
    <div class="card"><div id="aiChat" style="max-height:420px;overflow:auto">${a.chat.length?a.chat.map(m=>`
      <div style="padding:9px 0;border-bottom:1px solid var(--line)"><div class="hd">${m.role==='user'?'You':'Copilot'}${m.acts?` · ${esc(m.acts)}`:''}</div>
      <div style="white-space:pre-wrap;font-size:14px">${esc(m.text)}</div></div>`).join('')
      :'<div class="hd">Ask anything about the live data — “qui attend une réponse de moi ?”, “combien reste-t-il sur le budget ?”, “pourquoi le taux de réponse baisse ?”.</div>'}
      ${aiChatBusy?'<div class="note"><span class="spin"></span>Working…</div>':''}</div>
      <div style="display:flex;gap:8px;margin-top:12px"><input id="aiQ" placeholder="Ask or instruct…" ${aiReady()&&!aiChatBusy?'':'disabled'}
        onkeydown="if(event.key==='Enter')aiAsk(this.value)"><button class="btn p" ${aiReady()&&!aiChatBusy?'':'disabled'} onclick="aiAsk($('aiQ').value)">Send</button></div></div></div>

  <div class="sec"><div class="sh"><h2>Reply received outside Gmail</h2></div>
    <div class="card"><div class="cd" style="margin-bottom:12px">Paste a creator's answer from any inbox, DM or text — it goes through the same triage, address capture and agent as a Gmail reply.</div>
      ${pipeOpts?`<div class="fg"><label>From</label><select id="mrC">${pipeOpts}</select></div>
      <div class="fg"><label>Their message</label><textarea id="mrT" style="min-height:110px" placeholder="Paste the reply here…"></textarea></div>
      <button class="btn p" ${aiReady()?'':'disabled'} onclick="this.disabled=true;addManualReply($('mrC').value,$('mrT').value).then(()=>{renderAi();renderOut&&0})">Add & triage</button>`
      :'<div class="hd">Contact creators from Outreach first — they show up here once they are in the pipeline.</div>'}</div></div>

  <div class="sec"><div class="sh"><h2>Live stream${undig?` · ${num(undig)} waiting for the digest`:''}</h2>
    <button class="btn sm" ${aiReady()&&au.on&&undig?'':'disabled'} onclick="aiDigest(true);renderAi()">Digest now</button></div>
    <div class="card hist">${a.events.slice(0,30).map(e=>`<div class="h"><span><span class="tag">${esc(e.cat)}</span> ${esc(e.type.replace(/_/g,' '))}
      <span class="hd">${esc(evSummary(e))}</span></span>
      <b class="hd" style="font-weight:400;white-space:nowrap">${e.route==='now'?'⚡ ':e.digested?'✓ ':'· '}${new Date(e.at).toLocaleTimeString()}</b></div>`).join('')
      ||'<div class="hd">No events yet. Every feature reports here as you use it.</div>'}</div></div>

  <div class="sec"><div class="sh"><h2>Activity</h2></div>
    <div class="card hist">${(db.out.ailog||[]).slice(0,40).map(x=>`<div class="h"><span>${esc(x.msg)}</span>
      <b class="hd" style="font-weight:400">${new Date(x.at).toLocaleString()}</b></div>`).join('')||'<div class="hd">No automatic actions yet.</div>'}</div></div>`;
  const ch=$('aiChat');if(ch)ch.scrollTop=ch.scrollHeight;
  renderAiBadge()}

function evSummary(e){const d=e.data||{};
  return [d.name,d.added!=null?d.added+' new':'',d.count!=null?d.count+'':'',d.stage?'→ '+d.stage:'',d.intent||'',
    d.views!=null?num(d.views)+' views':'',d.total!=null?money(d.total):'',d.err?String(d.err).slice(0,60):'',d.keyword||''].filter(Boolean).join(' · ')}

async function aiAsk(q){
  q=(q||'').trim();if(!q||aiChatBusy)return;
  const a=aiCfg();a.chat.push({role:'user',text:q});aiChatBusy=true;renderAi();
  /* The last 24 turns go in whole, with what the agent did on each; anything
     older is folded into a running memory the system prompt carries. */
  const hist=[];a.chat.slice(-25,-1).forEach(m=>hist.push({role:m.role==='user'?'user':'assistant',
    content:(m.text||'…')+(m.role!=='user'&&m.acts?`\n[actions taken: ${m.acts}]`:'')}));
  while(hist.length&&hist[0].role!=='user')hist.shift();
  for(let i=hist.length-1;i>0;i--)if(hist[i].role===hist[i-1].role){hist[i-1].content+='\n'+hist[i].content;hist.splice(i,1)}
  try{const r=await opsRun(q,{history:hist,source:'chat'});
    const w=r.actions.filter(x=>!/^(get_|list_)/.test(x.tool)&&!(x.out&&x.out.error)).map(x=>x.tool);
    a.chat.push({role:'assistant',text:r.text||'(no answer)',acts:w.length?w.join(', '):''})}
  catch(e){a.chat.push({role:'assistant',text:'Error: '+e.message})}
  aiChatBusy=false;
  if(a.chat.length>60){const old=a.chat.slice(0,a.chat.length-40);a.chat=a.chat.slice(-40);chatRemember(old)}
  save();renderAi();renderPipeBadge()}

/* Folds old turns into a.memory: instructions, preferences and decisions the
   owner gave, so a conversation can run for weeks without losing them. */
async function chatRemember(old){
  try{const a=aiCfg();
    const text=old.map(m=>(m.role==='user'?'Owner: ':'Copilot: ')+String(m.text||'').slice(0,600)).join('\n');
    const j=await claudeCall({max_tokens:500,system:sys('You keep the long-term memory of an operations assistant. Output only the updated memory: short bullet lines, in the language the owner uses. Keep standing instructions, preferences, decisions, names and numbers the owner stated. Drop small talk and anything already done. Max 15 lines.'),
      messages:[{role:'user',content:`Current memory:\n${a.memory||'(empty)'}\n\nOlder conversation to fold in:\n${text}`}]});
    const t=textOf(j);if(t){a.memory=t.slice(0,2500);save()}}catch(e){}}

/* ── boot ─────────────────────────────────────────────────────────────── */
aiCfg();
setTimeout(async()=>{try{await stateReadyP}catch(e){}renderAiBadge();await checkBackend();
  if(aiCfg().backend.storage)syncNow();
  if(aiCfg().auto.on&&aiReady()){aiScan(true);aiDigest();aiSupervise()}},0);
if(typeof window!=='undefined'&&!window.__noTimers){
  setInterval(()=>{try{aiScan();aiDigest();aiSupervise()}catch(e){}},60000);
  setInterval(()=>{if(aiCfg().backend.storage)syncNow()},45000);
  setInterval(()=>{const b=aiCfg().backend;if(!b.key)checkBackend()},120000);
}

/* ═══ TRIAGE — every reply classified in a fixed format, checked, never guessed ═══
   The model answers through a forced tool call (no free text to parse), with
   the creator's record for context, a confidence score, the delivery signal
   and whether an address or a video link is in the message. Code then checks
   every answer: an intent outside the list, a missing reply or a confidence
   under the threshold never moves anything — it goes to the owner. Up to 12
   replies per call, so a backlog of thousands clears in minutes. */
const INTENTS=['INTERESTED','QUESTION','NEGOTIATE','DECLINE','OUT_OF_OFFICE','OTHER'];
const CLASSIFY_TOOL={name:'classify_replies',description:'Record the classification of every reply you were given — one result per reply_id, none skipped.',
  input_schema:{type:'object',properties:{results:{type:'array',items:{type:'object',properties:{
    reply_id:{type:'string'},
    intent:{type:'string',enum:INTENTS,description:'INTERESTED = a clear yes with no condition. Asking for more money, a flat fee, a minimum, or pushing back on the terms = NEGOTIATE. A neutral question about how it works (which platforms, how views are verified, when payment happens) = QUESTION. A creator who already has the product and confirms it arrived = OTHER (the delivery field carries it).'},
    confidence:{type:'number',description:'0 to 1: how sure you are of the intent. Below 0.75 a person checks it.'},
    delivery:{type:'string',enum:['none','received','not_received','damaged'],description:'what the message says about the product parcel; none if it says nothing'},
    has_address:{type:'boolean',description:'true only if the message contains a postal address'},
    video_url:{type:'string',description:'a link to a video they say they posted, else empty'},
    language:{type:'string',description:'ISO code of the language they wrote in'},
    summary:{type:'string',description:'one line, under 20 words, what they said'}},
    required:['reply_id','intent','confidence','delivery','has_address','summary']}}},required:['results']}};
const TRIAGE_BATCH=12;

function triageContext(rep){
  const p=rep.creatorId&&db.pipe&&db.pipe[rep.creatorId];
  const prev=(inboxCfg().replies||[]).filter(r=>r.creatorId&&r.creatorId===rep.creatorId&&r.gmId!==rep.gmId&&r.intent).slice(0,2);
  return `reply_id=${rep.gmId}
creator: ${p?`${p.name||p.email} · stage now "${p.stage}"${p.shippedAt?` · product shipped ${daysSince(new Date(p.shippedAt).getTime())} days ago`:''}${p.ship&&p.ship.status?` · parcel ${p.ship.status}`:''}${p.videoUrl?' · video logged':''}`:'unknown (not matched to a creator)'}
${prev.length?`their earlier replies: ${prev.map(r=>r.intent+(r.summary?' ('+r.summary+')':'')).join('; ')}\n`:''}message:
"""
${String(rep.body||'').slice(0,2500)}
"""`}

async function classifyReplies(reps){
  const out={};
  const ask=async list=>{
    const j=await claudeCall({max_tokens:220+list.length*170,system:sys(AGENTS.triage.system+`

You classify creator replies to a brand's outreach for a program that acts on your answer, so accuracy matters more than speed. Read each message fully, use the creator's current stage as context (someone who already received the product and writes "love it" is not a new INTERESTED lead — the delivery signal is what matters there). If a message could fit two intents, pick the one that needs the most care (NEGOTIATE over INTERESTED, QUESTION over INTERESTED) and lower your confidence. Call classify_replies once with a result for every reply_id.`),
      tools:[CLASSIFY_TOOL],tool_choice:{type:'tool',name:'classify_replies'},
      messages:[{role:'user',content:`${list.length} repl${list.length>1?'ies':'y'} to classify:\n\n`+list.map(triageContext).join('\n\n---\n\n')}]});
    const use=(j.content||[]).find(b=>b.type==='tool_use'&&b.name==='classify_replies');
    for(const r of (use&&use.input&&Array.isArray(use.input.results))?use.input.results:[]){
      if(!r||!list.some(x=>x.gmId===r.reply_id))continue;
      const intent=String(r.intent||'').toUpperCase();
      out[r.reply_id]={intent:INTENTS.includes(intent)?intent:'OTHER',
        confidence:INTENTS.includes(intent)?Math.max(0,Math.min(1,Number(r.confidence)||0)):0,
        delivery:['received','not_received','damaged'].includes(r.delivery)?r.delivery:'none',
        has_address:!!r.has_address,video_url:/^https?:\/\//.test(r.video_url||'')?String(r.video_url).slice(0,300):'',
        language:String(r.language||'').slice(0,8),summary:String(r.summary||'').slice(0,160)}}};
  await ask(reps);
  const missed=reps.filter(r=>!out[r.gmId]);
  for(const r of missed){try{await ask([r])}catch(e){}}   // one retry, alone, for anything skipped
  for(const r of reps)if(!out[r.gmId])out[r.gmId]={intent:'OTHER',confidence:0,delivery:'none',has_address:false,video_url:'',language:'',summary:'(could not be classified)'};
  return out}

async function applyTriage(rep,c){
  const a=aiCfg(),th=a.auto.reviewBelow||0.75;
  Object.assign(rep,{intent:c.intent,confidence:c.confidence,summary:c.summary,lang:c.language,delivery:c.delivery,needsReview:c.confidence<th});
  const p=rep.creatorId&&db.pipe&&db.pipe[rep.creatorId];
  if(p){
    /* facts the creator states are recorded whatever the confidence on intent */
    if(c.delivery==='received'&&p.shippedAt&&(!p.ship||p.ship.status!=='delivered'))
      updateShipment(p,{status:'delivered',note:'creator wrote: '+c.summary,source:'triage'});
    if((c.delivery==='not_received'||c.delivery==='damaged')&&p.shippedAt){
      updateShipment(p,{status:'issue',note:(c.delivery==='damaged'?'arrived damaged — ':'not received — ')+c.summary,source:'triage'});
      approvalAdd({type:'todo',kind:'todo:delivery',creatorId:p.id,title:p.name||p.email,
        why:`Delivery problem: ${c.summary}${p.ship&&p.ship.tracking?` · tracking ${p.ship.tracking}`:''}`,priority:'high'})}
    if(c.video_url&&!p.videoUrl&&p.shippedAt)setVideoUrl(p.id,c.video_url);
    if(rep.needsReview){
      if(CadenceAnalytics.STAGE_ORDER.indexOf(p.stage)<CadenceAnalytics.STAGE_ORDER.indexOf('replied'))advanceStage(p,'replied','Replied — to review');
      approvalAdd({type:'todo',kind:'todo:review-'+rep.gmId,creatorId:p.id,title:p.name||p.email,
        why:`Not sure how to read their reply (${c.intent}, ${Math.round(c.confidence*100)}% sure): “${c.summary}”. Check it before anything is sent.`,priority:'normal'})}
    else if(c.intent==='DECLINE')advanceStage(p,'declined','Replied — declined');
    else if(c.intent==='NEGOTIATE')advanceStage(p,'negotiating','Replied — negotiating, needs you');
    else if(c.intent==='INTERESTED')advanceStage(p,p.addr?'address_ready':'address_needed','Replied — interested');
    else if(c.intent!=='OUT_OF_OFFICE')advanceStage(p,'replied','Replied — '+c.intent);
    if(c.has_address&&CadenceAnalytics.STAGE_ORDER.indexOf(p.stage)<CadenceAnalytics.STAGE_ORDER.indexOf('shipped'))await tryExtractAddress(rep)}
  else if(!rep.creatorId)
    approvalAdd({type:'todo',kind:'todo:orphan-'+rep.gmId,title:rep.name||rep.email||'Unknown sender',
      why:`A reply could not be matched to any creator: “${c.summary}”.`,priority:'normal'})}

async function draftFor(rep){
  if(rep.intent==='OUT_OF_OFFICE'||rep.intent==='DECLINE'&&!rep.needsReview){rep.aiDraft=rep.aiDraft||'';return}
  const pp=rep.creatorId&&db.pipe&&db.pipe[rep.creatorId],ss=(db.out.sent||[]).find(x=>x.id===rep.creatorId)||{};
  const creator={name:rep.name,email:rep.email,handle:pp&&pp.handle||'',platform:pp&&pp.platform||'youtube',views:ss.views||0};
  rep.aiDraft=await runAgent('outreach',AI_TASKS.reply.build(creator,rep.body)+(pp?`\n\nContext: they are at the "${pp.stage}" stage${pp.ship&&pp.ship.status?`, parcel ${pp.ship.status}`:''}. Answer what they actually asked.`:''),500)}

async function triageBatch(reps){
  reps.forEach(r=>{r.status='triaging'});save();if(typeof renderOut==='function')try{renderOut()}catch(e){}
  let cls;
  try{cls=await classifyReplies(reps)}
  catch(e){reps.forEach(r=>{r.status='error';r.err=e.message});save();return}
  for(const rep of reps){
    try{await applyTriage(rep,cls[rep.gmId]);await draftFor(rep);rep.status='ready';rep.err='';
      aiEmit('reply_triaged',{rep})}
    catch(e){rep.status='error';rep.err=e.message}}
  save();if(typeof renderOut==='function')try{renderOut()}catch(e){}}

async function triageReply(rep){await triageBatch([rep])}

async function triageAllNew(){
  const box=inboxCfg();
  const todo=box.replies.filter(r=>r.status==='new'||r.status==='error');
  for(let i=0;i<todo.length;i+=TRIAGE_BATCH)await triageBatch(todo.slice(i,i+TRIAGE_BATCH));
  if(box.mode==='auto')
    for(const rep of box.replies.filter(r=>r.status==='ready'&&AUTO_SAFE.has(rep.intent)&&!rep.needsReview))
      await sendReply(rep,true)}

/* ═══ SAVED LISTS — Discover results, kept and classified in the cloud ══════
   A "list" is a named cut of Discover: the creators a search turned up,
   frozen at save time so it survives clearing the discovery cache, and
   synced to the server (see syncCollections) so it is there on any device,
   not just this browser. Every creator in it gets a niche/tier tag — from
   the AI ranking discovery already computed when there is one (TikTok's
   AI-ranked search), otherwise from one batched Sonnet pass here, so a list
   is always classified whatever produced it. ════════════════════════════ */
/* Audience size band from a follower count — deterministic, no AI needed or
   waited on for this one field. Matches the bands the AI classifier is also
   told to use, so a list looks the same whichever path filled it in. */
function tierFor(subs){subs=subs||0;return subs<10000?'nano':subs<100000?'micro':subs<1000000?'mid':'macro'}

const LIST_CLASSIFY_TOOL={name:'classify_creators',
  description:'Tag every creator in a saved discovery list — one result per id, none skipped — and describe the list as a whole.',
  input_schema:{type:'object',properties:{
    list_summary:{type:'string',description:'one line describing the whole list, e.g. "US sleep & wellness micro-creators, 20-150k subs"'},
    results:{type:'array',items:{type:'object',properties:{
      id:{type:'string'},
      category:{type:'string',description:'content niche in 1-3 words, e.g. "sleep & wellness", "ASMR", "fitness", "parenting"'},
      tier:{type:'string',enum:['nano','micro','mid','macro'],description:'by audience size: nano <10k, micro 10k-100k, mid 100k-1M, macro 1M+'}},
      required:['id','category','tier']}}},required:['list_summary','results']}};
const LIST_BATCH=25;

async function classifyList(id){
  const list=(db.lists||[]).find(l=>l.id===id);if(!list)return;
  const todo=(list.items||[]).filter(it=>!it.category);
  if(!aiReady()){if(!list.summary)list.summary='AI backend not connected — creators are unclassified.';save();return}
  for(let i=0;i<todo.length;i+=LIST_BATCH){
    const batch=todo.slice(i,i+LIST_BATCH);
    const lines=batch.map(it=>`id=${it.id} | ${it.name||it.handle||'?'} | ${it.platform||'?'} | ${num(it.subs||0)} followers | ${num(it.medViews||0)} median views | ${it.kw?'matched "'+it.kw+'"':''} ${it.country||''}`).join('\n');
    try{
      const j=await claudeCall({max_tokens:400+batch.length*60,
        system:sys('You classify creators found by an influencer discovery tool, from their public stats and the search keyword that matched them — you do not have their bio. Infer the most likely content niche from the name, handle and keyword. Call classify_creators once with a result for every id.'),
        tools:[LIST_CLASSIFY_TOOL],tool_choice:{type:'tool',name:'classify_creators'},
        messages:[{role:'user',content:`${batch.length} creators from the list "${list.name}"${list.note?' ('+list.note+')':''}:\n\n${lines}`}]});
      const use=(j.content||[]).find(b=>b.type==='tool_use'&&b.name==='classify_creators');
      if(use&&use.input){
        if(use.input.list_summary&&!list.summary)list.summary=String(use.input.list_summary).slice(0,200);
        for(const r of (Array.isArray(use.input.results)?use.input.results:[])){
          const it=list.items.find(x=>x.id===r.reply_id||x.id===r.id);if(!it)continue;
          it.category=String(r.category||'').slice(0,40)||'general';
          if(!it.tier)it.tier=['nano','micro','mid','macro'].includes(r.tier)?r.tier:''}}
    }catch(e){/* leave uncategorised — a retry (Reclassify) can try again, nothing is guessed */}
  }
  list.updatedAt=new Date().toISOString();save();
  emit('list_classified',{id:list.id,name:list.name,count:(list.items||[]).length});
  renderListsIfOpen()}

/** items: full discovery records (from targets()/idbGetMany). Existing per-record
 *  AI data (TikTok's own ranked search) is kept as the category/tier source and
 *  never re-classified — only creators with no ai data go through classifyList. */
async function saveList(name,items,opts){
  name=(name||'').trim();if(!name||!items||!items.length)return null;
  opts=opts||{};
  const list={id:uid(),name,note:opts.note||'',tags:[],source:opts.source||'discover',jobId:opts.jobId||'',
    filters:opts.filters||{},summary:opts.summary||'',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),
    items:items.slice(0,500).map(l=>({id:l.id,name:l.name||'',handle:l.handle||'',platform:l.platform||opts.platform||'youtube',
      email:l.email||'',url:l.url||'',subs:l.subs||0,medViews:l.medViews||l.views||0,kw:l.kw||'',country:l.country||'',
      category:l.ai&&l.ai.niche?String(l.ai.niche).slice(0,40):'',tier:tierFor(l.subs||0)}))};
  if(!db.lists)db.lists=[];db.lists.unshift(list);db.lists=db.lists.slice(0,200);save();
  emit('list_saved',{id:list.id,name,count:list.items.length,source:list.source});
  renderListsIfOpen();
  if((list.items||[]).some(it=>!it.category))classifyList(list.id); // fire-and-forget: only whatever still lacks a category
  return list}

/* Which other lists a creator already sits in — so overlap between searches
   is visible instead of silently duplicating outreach effort. Built on
   demand from db.lists rather than maintained incrementally: lists rarely
   number more than a few hundred, so a full pass is cheap. */
function listOverlap(excludeListId){
  const by={};
  (db.lists||[]).forEach(l=>{if(l.id===excludeListId)return;
    (l.items||[]).forEach(it=>{(by[it.id]=by[it.id]||[]).push(l.name)})});
  return by}

function deleteList(id){
  const list=(db.lists||[]).find(l=>l.id===id);if(!list)return;
  if(typeof confirm==='function'&&!confirm(`Delete "${list.name}" (${list.items.length} creators)? This only removes the saved list — nothing in Discover or the pipeline.`))return;
  db.lists=(db.lists||[]).filter(l=>l.id!==id);save();
  emit('list_deleted',{id,name:list.name});
  renderListsIfOpen()}

function renderListsIfOpen(){if(typeof document!=='undefined'&&typeof renderLists==='function'){
  const v=$('v-lists');if(v&&v.classList.contains('on'))renderLists()}}
