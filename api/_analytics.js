/* ═══ CADENCE DATA MODEL + ANALYTICS — one file, used by the app and the server ══
   The browser inlines this file at build time; the server requires it. Same
   code, same numbers on both sides.

   Everything hangs off one key: the creator id (platform:handle, e.g.
   "youtube:UCxyz" or "tiktok:nora"). It is the lead id in discovery, the
   pipeline id, the outreach id, the reply's creatorId and the campaign
   line's pid.                                                              */
(function(root){
const DATA_MODEL=`DATA MODEL — every record is keyed by creator id (platform:handle).
- creator (pipeline): id, name, email, handle, platform, stage, views (median views/video), subs, kw (discovery keyword), country, campaignId, addedAt, addr, videoUrl, shippedAt, ship, log[{at,msg}] newest first.
- ship (delivery of the product): carrier, tracking, status (shipped|in_transit|delivered|issue|returned), deliveredAt, updates[{at,status,note,source}] newest first. Delivery is confirmed by the creator's own words ("got it", "arrived") or by the owner — never assumed.
- sent (first outreach email): id → at, ok, err, views, gmThreadId.
- reply: gmId, creatorId, at, body, intent (INTERESTED|QUESTION|NEGOTIATE|DECLINE|OUT_OF_OFFICE|OTHER), confidence (0–1), needsReview (true when confidence < 0.75: a person checks it before anything acts on it), summary, delivery (none|received|not_received|damaged), status (new|ready|sent|skipped|error), aiDraft, manual.
- campaign: id, name, budget, spent, owed, views, budget_used_pct, lines[{pid (creator id), name, rate, views}].
- event: at, type, category, data — the stream every feature writes to.
- approval: something only the owner can decide (email to send, to-do). insight: an observation for the owner.
Stages in order: shortlisted → contacted → replied → negotiating → address_needed → address_ready → shipped → live_pending → live_missing_link → live_ok; declined can happen before shipping. Stages only move forward: moving a creator back needs allow_backward with a reason, and a creator who already has the product is never auto-declined — that goes to the owner.
Use query_creators to filter/sort thousands of creators and get_segments to compare conversion by platform, views band, keyword, country, week contacted or campaign. Prefer these to reading creators one by one. audit_data checks every record for contradictions (a stage without the data it implies, duplicates, orphan replies, untriaged or doubtful replies); get_shipments tracks every parcel.`;

const STAGE_ORDER=['shortlisted','contacted','replied','negotiating','address_needed','address_ready','shipped','live_pending','live_missing_link','live_ok'];
const idx=s=>STAGE_ORDER.indexOf(s);
const DAY=86400000;
const BANDS=[[0,5000,'<5k'],[5000,20000,'5–20k'],[20000,50000,'20–50k'],[50000,150000,'50–150k'],[150000,500000,'150–500k'],[500000,Infinity,'500k+']];
const band=v=>{v=Number(v)||0;const b=BANDS.find(([a,z])=>v>=a&&v<z);return b?b[2]:'unknown'};
const week=t=>{if(!t)return 'never';const d=new Date(t);const day=(d.getUTCDay()+6)%7;d.setUTCDate(d.getUTCDate()-day);return d.toISOString().slice(0,10)};
const lastAt=p=>p&&p.log&&p.log[0]?new Date(p.log[0].at).getTime():0;
const shipStatus=p=>p&&p.ship&&p.ship.status?p.ship.status:(p&&p.shippedAt?'shipped':'');
/* Forward-only stage moves. Returns '' when allowed, else the reason it is not. */
function stageMoveProblem(from,to,allowBackward){
  if(from===to)return 'already at that stage';
  if(to==='declined')return idx(from)>=idx('shipped')?'this creator already has the product — flag it for the owner instead of declining':'';
  if(from==='declined')return '';
  if(idx(to)<0)return 'unknown stage';
  if(idx(to)<idx(from)&&!allowBackward)return `moving back from ${from} to ${to} — pass allow_backward:true with the reason if the data really says so`;
  return ''}

/* One flat row per creator with everything a filter or a segment needs.
   ctx: {pipe:{id:creator}, sent:{id:sent}, replies:[reply], now} */
function rows(ctx){
  const now=ctx.now||Date.now();
  const byC={};for(const r of ctx.replies||[]){if(!r.creatorId)continue;(byC[r.creatorId]||(byC[r.creatorId]=[])).push(r)}
  return Object.values(ctx.pipe||{}).map(p=>{
    const s=(ctx.sent||{})[p.id]||null,reps=byC[p.id]||[];
    const views=Number(p.views)||Number(s&&s.views)||0;
    const la=lastAt(p);
    const intents=[...new Set(reps.map(r=>r.intent).filter(Boolean))];
    return {id:p.id,name:p.name||'',email:p.email||'',platform:p.platform||'youtube',stage:p.stage||'shortlisted',
      views,subs:Number(p.subs)||0,kw:p.kw||'',country:p.country||'',campaign:p.campaignId||'',
      contacted_at:s&&s.ok?s.at:null,send_failed:!!(s&&!s.ok),
      replied:reps.length>0||(p.stage==='declined'&&!!s)||idx(p.stage)>=idx('replied'),
      replies:reps.length,intents,has_address:!!p.addr,has_video:!!p.videoUrl,
      ship_status:shipStatus(p),delivered:shipStatus(p)==='delivered',
      days_since_shipped:p.shippedAt?Math.floor((now-new Date(p.shippedAt).getTime())/DAY):null,
      days_since_delivered:p.ship&&p.ship.deliveredAt?Math.floor((now-new Date(p.ship.deliveredAt).getTime())/DAY):null,
      shipped:idx(p.stage)>=idx('shipped'),live:idx(p.stage)>=idx('live_pending'),live_ok:p.stage==='live_ok',
      declined:p.stage==='declined',
      days_since_last_event:la?Math.floor((now-la)/DAY):null,
      days_since_contact:s&&s.ok?Math.floor((now-new Date(s.at).getTime())/DAY):null}})}

function matches(r,f){
  if(f.stage){const st=Array.isArray(f.stage)?f.stage:[f.stage];if(!st.includes(r.stage))return false}
  if(f.platform&&r.platform!==f.platform)return false;
  if(f.min_views!=null&&r.views<f.min_views)return false;
  if(f.max_views!=null&&r.views>f.max_views)return false;
  if(f.keyword&&!r.kw.toLowerCase().includes(String(f.keyword).toLowerCase()))return false;
  if(f.country&&r.country!==f.country)return false;
  if(f.campaign&&r.campaign!==f.campaign)return false;
  if(f.intent&&!r.intents.includes(f.intent))return false;
  if(f.ship_status&&r.ship_status!==f.ship_status)return false;
  for(const k of ['has_email','has_address','has_video','replied','shipped','live','declined','send_failed']){
    if(f[k]===true&&!(k==='has_email'?!!r.email:r[k]))return false;
    if(f[k]===false&&(k==='has_email'?!!r.email:r[k]))return false}
  if(f.silent_days_min!=null&&!(r.days_since_last_event!=null&&r.days_since_last_event>=f.silent_days_min))return false;
  if(f.contacted_days_min!=null&&!(r.days_since_contact!=null&&r.days_since_contact>=f.contacted_days_min))return false;
  if(f.contacted_days_max!=null&&!(r.days_since_contact!=null&&r.days_since_contact<=f.contacted_days_max))return false;
  if(f.query){const q=String(f.query).toLowerCase();if(!(r.name+' '+r.email+' '+r.id).toLowerCase().includes(q))return false}
  return true}

const SORTS={views:r=>r.views,last_event:r=>-(r.days_since_last_event??1e9),silence:r=>r.days_since_last_event??-1,
  contacted:r=>r.contacted_at?new Date(r.contacted_at).getTime():0,name:r=>r.name.toLowerCase(),subs:r=>r.subs};

function queryCreators(ctx,f){
  f=f||{};const all=rows(ctx).filter(r=>matches(r,f));
  const key=SORTS[f.sort]||SORTS.views,dir=f.order==='asc'?1:-1;
  all.sort((a,b)=>{const x=key(a),y=key(b);return x<y?-dir:x>y?dir:0});
  const by_stage={};all.forEach(r=>by_stage[r.stage]=(by_stage[r.stage]||0)+1);
  const limit=Math.min(Math.max(Number(f.limit)||25,1),200),offset=Math.max(Number(f.offset)||0,0);
  const fields=['id','name','email','platform','stage','views','subs','kw','country','days_since_last_event','days_since_contact','has_address','has_video','intents','ship_status','days_since_shipped'];
  return {total:all.length,offset,limit,by_stage,
    total_views:all.reduce((a,r)=>a+r.views,0),
    creators:all.slice(offset,offset+limit).map(r=>Object.fromEntries(fields.map(k=>[k,r[k]])))}}

const DIMS={platform:r=>r.platform,views_band:r=>band(r.views),keyword:r=>r.kw||'(none)',country:r=>r.country||'(unknown)',
  week_contacted:r=>week(r.contacted_at),campaign:r=>r.campaign||'(none)',stage:r=>r.stage};
const pct=(a,b)=>b?Math.round(a/b*1000)/10:0;

function segments(ctx,{dimension='platform',only_contacted=true,min_size=1}={}){
  const fn=DIMS[dimension];if(!fn)return {error:'dimension must be one of '+Object.keys(DIMS).join(', ')};
  const g={};
  for(const r of rows(ctx)){if(only_contacted&&!r.contacted_at)continue;
    const k=fn(r),s=g[k]||(g[k]={segment:k,creators:0,replied:0,interested:0,shipped:0,live:0,live_ok:0,declined:0,views_sum:0});
    s.creators++;s.views_sum+=r.views;if(r.replied)s.replied++;
    if(r.has_address||idx(r.stage)>=idx('address_needed'))s.interested++;
    if(r.shipped)s.shipped++;if(r.live)s.live++;if(r.live_ok)s.live_ok++;if(r.declined)s.declined++}
  const list=Object.values(g).filter(s=>s.creators>=min_size).map(s=>({segment:s.segment,creators:s.creators,
    reply_rate:pct(s.replied,s.creators),interest_rate:pct(s.interested,s.creators),ship_rate:pct(s.shipped,s.creators),
    live_rate:pct(s.live,s.creators),decline_rate:pct(s.declined,s.creators),avg_views:s.creators?Math.round(s.views_sum/s.creators):0,
    counts:{replied:s.replied,interested:s.interested,shipped:s.shipped,live:s.live,live_ok:s.live_ok,declined:s.declined}}))
    .sort((a,b)=>b.creators-a.creators);
  const tot=list.reduce((a,s)=>a+s.creators,0);
  return {dimension,segments:list.slice(0,40),total_creators:tot,
    overall:{reply_rate:pct(list.reduce((a,s)=>a+s.counts.replied,0),tot),live_rate:pct(list.reduce((a,s)=>a+s.counts.live,0),tot)}}}

/* ── audit: every record checked against what its stage implies ─────────
   Plain code, so it is exact on 50 or 50,000 creators. The model reads the
   result; it does not have to spot contradictions by eye. */
function audit(ctx){
  const now=ctx.now||Date.now(),pipe=ctx.pipe||{},sent=ctx.sent||{},reps=ctx.replies||[];
  const checks={};const add=(k,sev,ex)=>{const c=checks[k]||(checks[k]={check:k,severity:sev,count:0,examples:[]});c.count++;if(c.examples.length<15)c.examples.push(ex)};
  const at=s=>idx(s);const byEmail={};const replied=new Set();
  for(const r of reps){
    if(!r.creatorId)add('reply_without_creator','high',{reply_id:r.gmId,from:r.email||r.name||''});
    else if(!pipe[r.creatorId])add('reply_for_unknown_creator','high',{reply_id:r.gmId,creator_id:r.creatorId});
    else replied.add(r.creatorId);
    const age=(now-new Date(r.at).getTime())/3600000;
    if((r.status==='new'||r.status==='error')&&age>1)add('reply_not_triaged','high',{reply_id:r.gmId,creator_id:r.creatorId,hours:Math.round(age)});
    if(r.needsReview&&r.status!=='sent'&&r.status!=='skipped')add('classification_to_review','normal',{reply_id:r.gmId,creator_id:r.creatorId,intent:r.intent,confidence:r.confidence})}
  for(const p of Object.values(pipe)){
    const st=p.stage||'shortlisted',s=sent[p.id],ex={id:p.id,name:p.name||p.email||'',stage:st};
    if(!p.email&&at(st)>=at('contacted'))add('no_email_but_contacted','normal',ex);
    if(p.email){const e=p.email.toLowerCase().trim();(byEmail[e]||(byEmail[e]=[])).push(p.id)}
    if(at(st)>=at('contacted')&&st!=='declined'&&!(s&&s.ok)&&!replied.has(p.id))add('contacted_without_send','normal',ex);
    if(s&&s.ok&&st==='shortlisted')add('sent_but_still_shortlisted','high',ex);
    if(at(st)>=at('replied')&&!replied.has(p.id)&&!(p.log||[]).some(l=>/repl/i.test(l.msg||'')))add('replied_stage_without_reply','normal',ex);
    if(st==='address_ready'&&!p.addr)add('ready_to_ship_without_address','high',ex);
    if(p.addr&&(!p.addr.line1||!p.addr.city||!p.addr.country))add('address_incomplete','high',ex);
    if(at(st)>=at('shipped')&&!p.shippedAt)add('shipped_without_date','normal',ex);
    if(at(st)>=at('live_pending')&&!p.videoUrl)add('live_without_video_link','high',ex);
    if(p.videoUrl&&at(st)<at('shipped')&&st!=='declined')add('video_before_shipping','normal',ex);
    const ss=shipStatus(p);
    if(ss==='delivered'&&at(st)<at('shipped'))add('delivered_but_not_shipped','high',ex);
    if(ss==='issue')add('delivery_issue_open','high',{...ex,note:((p.ship.updates||[])[0]||{}).note||''});
    if(p.campaignId&&ctx.camps&&!ctx.camps[p.campaignId])add('unknown_campaign','normal',{...ex,campaign:p.campaignId})}
  for(const [e,ids] of Object.entries(byEmail))if(ids.length>1)add('duplicate_email','high',{email:e,ids});
  const issues=Object.values(checks).sort((a,b)=>(a.severity==='high'?0:1)-(b.severity==='high'?0:1)||b.count-a.count);
  return {creators:Object.keys(pipe).length,replies:reps.length,clean:!issues.length,
    issues_total:issues.reduce((a,c)=>a+c.count,0),issues}}

/* ── shipments: where every parcel is ───────────────────────────────── */
function shipments(ctx,{status,overdue_days=7,limit=30}={}){
  const now=ctx.now||Date.now();const list=[];const by={};
  for(const p of Object.values(ctx.pipe||{})){
    const ss=shipStatus(p);if(!ss)continue;by[ss]=(by[ss]||0)+1;
    const sd=p.shippedAt?Math.floor((now-new Date(p.shippedAt).getTime())/DAY):null;
    const dd=p.ship&&p.ship.deliveredAt?Math.floor((now-new Date(p.ship.deliveredAt).getTime())/DAY):null;
    list.push({id:p.id,name:p.name||p.email||'',stage:p.stage,ship_status:ss,carrier:p.ship&&p.ship.carrier||'',
      tracking:p.ship&&p.ship.tracking||'',days_since_shipped:sd,days_since_delivered:dd,has_video:!!p.videoUrl,
      last_update:p.ship&&p.ship.updates&&p.ship.updates[0]||null})}
  const overdue=list.filter(x=>(x.ship_status==='shipped'||x.ship_status==='in_transit')&&x.days_since_shipped!=null&&x.days_since_shipped>=overdue_days);
  const waitingVideo=list.filter(x=>x.ship_status==='delivered'&&!x.has_video);
  const pick=status?list.filter(x=>x.ship_status===status):list;
  pick.sort((a,b)=>(b.days_since_shipped||0)-(a.days_since_shipped||0));
  return {total:list.length,by_status:by,overdue_in_transit:overdue.length,delivered_no_video:waitingVideo.length,
    issues:list.filter(x=>x.ship_status==='issue').length,
    overdue:overdue.slice(0,limit),delivered_waiting_video:waitingVideo.sort((a,b)=>(b.days_since_delivered||0)-(a.days_since_delivered||0)).slice(0,limit),
    parcels:pick.slice(0,limit)}}

const TOOL_SCHEMAS={
  audit_data:{description:'Check every creator and reply for contradictions: a stage without the data it implies, duplicate emails, orphan or untriaged replies, doubtful classifications, open delivery issues. Exact, runs in code over all records. Returns each problem with a count and examples.',
    input_schema:{type:'object',properties:{}}},
  get_shipments:{description:'Every parcel sent to creators: counts by delivery status, parcels overdue in transit, parcels delivered with no video yet, open issues.',
    input_schema:{type:'object',properties:{status:{type:'string',enum:['shipped','in_transit','delivered','issue','returned']},
      overdue_days:{type:'number',description:'days in transit before a parcel counts as overdue (default 7)'},limit:{type:'integer'}}}},
  query_creators:{description:'Filter, sort and page through every creator (works on thousands). Returns matching count, count by stage, total views and one page of rows.',
    input_schema:{type:'object',properties:{
      stage:{description:'one stage or a list of stages',anyOf:[{type:'string'},{type:'array',items:{type:'string'}}]},
      platform:{type:'string'},min_views:{type:'number'},max_views:{type:'number'},keyword:{type:'string'},country:{type:'string'},
      campaign:{type:'string'},intent:{type:'string'},has_email:{type:'boolean'},has_address:{type:'boolean'},has_video:{type:'boolean'},
      replied:{type:'boolean'},shipped:{type:'boolean'},live:{type:'boolean'},declined:{type:'boolean'},send_failed:{type:'boolean'},
      ship_status:{type:'string',enum:['shipped','in_transit','delivered','issue','returned']},
      silent_days_min:{type:'number'},contacted_days_min:{type:'number'},contacted_days_max:{type:'number'},query:{type:'string'},
      sort:{type:'string',enum:Object.keys(SORTS)},order:{type:'string',enum:['asc','desc']},limit:{type:'integer'},offset:{type:'integer'}}}},
  get_segments:{description:'Compare conversion (reply, interest, ship, live, decline rates, average views) across segments of contacted creators: platform, views_band, keyword, country, week_contacted, campaign or stage. Use it to decide where to push and what to stop.',
    input_schema:{type:'object',properties:{dimension:{type:'string',enum:Object.keys(DIMS)},
      only_contacted:{type:'boolean'},min_size:{type:'integer'}},required:['dimension']}},
};

const A={DATA_MODEL,STAGE_ORDER,rows,queryCreators,segments,band,TOOL_SCHEMAS,audit,shipments,stageMoveProblem,shipStatus};
if(typeof module!=='undefined'&&module.exports)module.exports=A;else root.CadenceAnalytics=A;
})(typeof window!=='undefined'?window:globalThis);
