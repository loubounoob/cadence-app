
/* ═══ DISCOVERY ENGINE — TikTok at 10,000+ creators ═══════════════════════
   Why the old search returned one creator: it asked TikTok's *user* search for
   30 profiles per keyword. That search is shallow and surfaces the biggest
   accounts first, so a 5k–500k band threw 29 of 30 away.

   The engine works the other way round:
   1. PLAN     Sonnet turns a one-line brief into 40–120 hashtags and video
               search phrases (head, mid and long-tail, in the market's language).
   2. HARVEST  Hashtag and video-search feeds are where small and mid creators
               live. Each post carries its author, so every row is a candidate.
               Runs are started asynchronously on the provider and collected
               page by page while they run — nothing waits on one long request,
               and a closed tab picks up where it left off.
   3. FILTER   Plain code, instant at any volume: followers band, language,
               duplicates. Everything kept goes straight into the lead index.
   4. SCORE    Sonnet reads creators 40 at a time against the brief and returns
               fit 0–100, niche, a reason and red flags. That score drives the
               ranking and Quick pick.
   5. DEEPEN   Optionally read the last 10 posts of the best N for a real median.

   It stops by itself once the target is reached and aborts the remaining runs,
   so you never pay for rows you no longer need. ═══════════════════════════ */
const DX_FIELDS='text,textLanguage,createTimeISO,playCount,diggCount,commentCount,isSponsored,authorMeta,searchHashtag,searchQuery,input';
const DX_ROW_COST=0.0027;                 // provider price per row, as billed today
const DX_MAX_RUNNING=4, DX_PAGE=1000, DX_PAGES_PER_TICK=6, DX_SCORE_BATCH=40;
/* ── two-tier review ───────────────────────────────────────────────────────
   Every kept creator gets a fast, cheap Haiku pass first (DX_TRIAGE_BATCH at
   a time). Only those it doesn't confidently reject move on to a slower,
   stricter Sonnet pass with real reading material (their actual recent
   posts, fetched fresh for exactly this shortlist — never for the wide
   pool). This is what keeps reviewing 10,000+ creators affordable: the
   model that costs the most only ever looks at the few hundred that matter. */
const DX_TRIAGE_BATCH=40, DX_TRIAGE_MIN=42;   // permissive — Sonnet makes the real call
const DX_DEEP_BATCH=15, DX_DEEPEN_MAX_POSTS=8; // smaller batches, richer prompt
/* ── Étage 1: free collection ────────────────────────────────────────────
   Before paying the provider by the row, every hashtag/sound in the plan
   first gets a cheap poll against /api/free-pull — rows an outside
   harvester (harvest/free-harvest.mjs, run for free on GitHub Actions)
   already queued from TikTok's own public hashtag and sound pages, the
   same "UGC tagged with this tag" content Creative Center points at, read
   at $0 provider cost. Whatever a hashtag doesn't get for free, the
   existing paid runs below still cover in full — this tier only ever
   *reduces* how much of that paid capacity actually gets used, it never
   gates or delays the harvest. */
const DX_FREE_PULL=500, DX_FREE_MAX_TICKS=6;
const MARKET_LANG={US:'en',GB:'en',CA:'en',AU:'en',IE:'en',NZ:'en',FR:'fr',BE:'fr',DE:'de',AT:'de',ES:'es',MX:'es',BR:'pt',PT:'pt',IT:'it',NL:'nl'};

AGENTS.scout={name:'Scout',role:'Plans creator searches and gives the final, strict verdict on shortlisted creators',
  system:`You are a TikTok creator scout for brand campaigns paid per view. You know how TikTok hashtags and search behave: head tags (#fitness) are huge and noisy, mid tags (#gymtok, #legday) hold most working creators, long-tail tags (#homeworkoutforwomen) are small but precise. Creators with 5k–500k followers mostly surface through mid and long-tail tags and video search, rarely through user search.
You are the last, strict checkpoint before a creator reaches the brand's list — a faster first pass has already cleared obvious mismatches, so everyone you see deserves a careful, evidence-based read, not a rubber stamp.
You answer only in the exact JSON format asked for, with no text before or after it.`};

AGENTS.dxTriage={name:'Scout triage',role:'Fast first pass over every kept creator, to shortlist who deserves a deep review',
  system:`You are a fast first-pass filter for a TikTok creator-sourcing funnel. Thousands of creators come through you; only the plausible ones move on to a slower, more careful reviewer. Your job is not to make the final call — it is to cheaply and quickly throw out the clear no's (wrong niche entirely, obvious brand/company account, clearly a repost/meme page, content for kids, adult content) and wave everything else through, even when unsure. A false "maybe" costs a little extra downstream review; a false "no" loses a creator forever — when genuinely unsure, lean toward passing them on.
You answer only in the exact JSON format asked for, with no text before or after it.`};

function dxCfg(){
  if(!db.disc)db.disc={};
  if(!db.disc.dx)db.disc.dx={brief:'',market:'US',min:5000,max:500000,target:10000,scoreMax:10000,job:null,history:[]};
  return db.disc.dx}
function dxJob(){return dxCfg().job}
const dxLang=m=>MARKET_LANG[(m||'').toUpperCase()]||'';

/* ── 1. PLAN ───────────────────────────────────────────────────────────── */
function dxFallbackPlan(brief){
  const words=String(brief).toLowerCase().replace(/[^a-z0-9àâäéèêëîïôöùûüç\s]/g,' ').split(/\s+/).filter(w=>w.length>2);
  const base=[...new Set(words)].slice(0,8);
  const tags=new Set();
  base.forEach(w=>{tags.add(w);['tok','life','tips','routine','girl','motivation'].forEach(s=>tags.add(w+s))});
  for(let i=0;i<base.length-1;i++)tags.add(base[i]+base[i+1]);
  return {hashtags:[...tags].slice(0,40),queries:base.length?[base.join(' ')]:[],negative:[],persona:brief,source:'fallback'}}

async function dxPlan(brief,market,target){
  const lang=dxLang(market)||'en';
  const n=Math.max(40,Math.min(120,Math.round(target/120)));
  if(!aiReady())return dxFallbackPlan(brief);
  const task=`PLANNER
Brief: """${String(brief).slice(0,800)}"""
Market: ${market||'any'} — main language: ${lang}.
Target: about ${num(target)} distinct creators with ${num(dxCfg().min)}–${num(dxCfg().max)} followers.

Give ${n} hashtags and ${Math.round(n/4)} video search phrases that, together, reach that many distinct creators in this niche.
- ~15% head tags, ~50% mid tags, ~35% long-tail tags. Lowercase, no #, no spaces, no brand names.
- Use the market language${lang!=='en'?' and a few English tags the local creators also use':''}.
- Search phrases are what a viewer types (3–6 words), in the market language.
- "negative": words that signal the wrong creators (e.g. brands, meme pages, other niches).
- "persona": one sentence describing the ideal creator.

JSON: {"hashtags":[...],"queries":[...],"negative":[...],"persona":"..."}`;
  try{
    const p=await runJSON('scout',task,3000);
    const clean=a=>[...new Set((Array.isArray(a)?a:[]).map(x=>String(x).toLowerCase().replace(/^#/,'').replace(/[^\p{L}\p{N}_]/gu,'')).filter(x=>x.length>1))];
    const plan={hashtags:clean(p.hashtags).slice(0,150),queries:[...new Set((p.queries||[]).map(q=>String(q).trim()).filter(Boolean))].slice(0,40),
      negative:(p.negative||[]).map(String).slice(0,30),persona:String(p.persona||brief).slice(0,300),source:'ai'};
    if(plan.hashtags.length<5)return dxFallbackPlan(brief);
    return plan
  }catch(e){const f=dxFallbackPlan(brief);f.err=e.message;return f}}

/* Rows to ask for per hashtag, from the target: about 0.6 new creators per row
   once duplicates are folded, about 40% of those inside the band. */
function dxBudget(plan,target){
  const units=plan.hashtags.length+plan.queries.length||1;
  const rows=Math.ceil(target/0.6/0.4);
  const per=Math.max(100,Math.min(1500,Math.ceil(rows/units/50)*50));
  return {perUnit:per,rows:per*units,cost:+(per*units*DX_ROW_COST).toFixed(2),units}}

/* ── provider: Apify async runs ────────────────────────────────────────── */
async function apify(path,opts){
  const t=provToken();if(!t)throw new Error('No provider token in this build.');
  const url=`https://api.apify.com/v2${path}${path.includes('?')?'&':'?'}token=${encodeURIComponent(t)}`;
  const r=await fetch(url,opts||{});
  if(!r.ok){let m='';try{m=(await r.text()).slice(0,200)}catch(e){}throw new Error(`Provider ${r.status}: ${m}`)}
  return r.json()}
const DX_OFF={shouldDownloadVideos:false,shouldDownloadCovers:false,shouldDownloadSubtitles:false,shouldDownloadSlideshowImages:false,shouldDownloadAvatars:false};

function dxMakeRuns(plan,per,market){
  const runs=[],co=(market||'').toUpperCase();
  const px=co?{proxyCountryCode:co}:{};
  // Étage 1 — one free poll per hashtag, ahead of every paid run below.
  for(const tag of plan.hashtags)runs.push({key:'free'+tag,kind:'free',tag,label:'#'+tag+' (free)',status:'PENDING',offset:0,rows:0,ticks:0});
  for(let i=0;i<plan.hashtags.length;i+=8){const tags=plan.hashtags.slice(i,i+8);
    runs.push({key:'h'+i,kind:'hashtags',label:tags.join(', '),max:tags.length*per,
      input:{hashtags:tags,resultsPerPage:per,...DX_OFF,...px},status:'PENDING',offset:0,rows:0})}
  for(let i=0;i<plan.queries.length;i+=5){const q=plan.queries.slice(i,i+5);
    runs.push({key:'q'+i,kind:'search',label:q.join(' · '),max:q.length*per,
      input:{searchQueries:q,searchSection:'/video',resultsPerPage:per,...DX_OFF,...px},status:'PENDING',offset:0,rows:0})}
  return runs}

/* ── job lifecycle ─────────────────────────────────────────────────────── */
function dxNewJob(brief,market,plan){
  const c=dxCfg(),b=dxBudget(plan,c.target);
  c.job={id:'dx'+Date.now().toString(36),brief,market,lang:dxLang(market),min:c.min,max:c.max,target:c.target,
    /* No cap: every single creator the harvest keeps gets reviewed by the AI,
       including the handful that land past the target before a run finishes
       aborting — quality means nothing collected goes unjudged. */
    scoreMax:Number.MAX_SAFE_INTEGER,plan,per:b.perUnit,estimate:b,runs:dxMakeRuns(plan,b.perUnit,market),status:'planned',
    stats:{rows:0,free:0,seen:0,kept:0,added:0,outBand:0,wrongLang:0,negative:0,triaged:0,triageRejected:0,scored:0,scoreErr:0},
    toDeep:[],createdAt:new Date().toISOString(),log:[]};
  save();return c.job}
function dxLog(j,m){j.log=[{at:new Date().toISOString(),m},...(j.log||[])].slice(0,40)}

async function dxLaunch(){
  const j=dxJob();if(!j||j.status==='done')return;
  j.status='running';j.startedAt=j.startedAt||new Date().toISOString();dxLog(j,'Launched');
  emit('discovery_started',{job:j.id,runs:j.runs.length,target:j.target,estimate_usd:j.estimate.cost});
  save();dxStartLoop();await dxTick()}

let dxTimer=null,dxBusy=false;
function dxStartLoop(){if(typeof window!=='undefined'&&window.__noTimers)return;
  if(!dxTimer)dxTimer=setInterval(()=>{dxTick().catch(()=>{})},8000)}
function dxStopLoop(){if(dxTimer){clearInterval(dxTimer);dxTimer=null}}

async function dxTick(){
  const j=dxJob();
  if(!j||dxBusy||!['running','scoring','deepening'].includes(j.status)){if(!j||['done','paused','planned'].includes(j&&j.status))dxStopLoop();return}
  dxBusy=true;
  try{
    /* The harvest run-loop also drives the small "fetch fresh posts for the
       shortlist" runs queued by dxQueueDeepen during the deepening phase —
       same provider, same start/collect mechanics, just a different status
       gates the harvest-specific parts (target-reached abort, handoff to
       scoring) below. */
    if(j.status==='running'||j.runs.some(r=>r.status==='PENDING'||(r.id&&!r.collected))){
      // Étage 1 — free tier first: one cheap GET per hashtag against whatever
      // the outside harvester already queued, no provider run to start, no
      // concurrency slot used. Best-effort: any failure here just leaves
      // that hashtag to the paid run below, it never breaks the harvest.
      for(const r of j.runs.filter(r=>r.kind==='free'&&!r.collected)){
        r.ticks=(r.ticks||0)+1;
        try{
          const resp=await apiFetch(`/api/free-pull?tag=${encodeURIComponent(r.tag)}&limit=${DX_FREE_PULL}`);
          const d=await resp.json();
          const items=(d&&Array.isArray(d.items))?d.items:[];
          if(items.length){await dxIngest(j,items,{kind:'hashtags',label:'#'+r.tag});r.rows+=items.length;j.stats.free+=items.length}
          if(!d||!d.more){
            r.collected=true;
            // nothing pre-harvested for this tag at all — ask the outside
            // harvester to pick it up on its next pass (see /api/free-request),
            // so a search's own hashtags widen free coverage over time instead
            // of only ever working the fixed list in harvest/tags.json.
            if(!r.rows)apiFetch('/api/free-request',{method:'POST',headers:{'Content-Type':'application/json'},
              body:JSON.stringify({tag:r.tag})}).catch(()=>{})}}
        catch(e){r.collected=true}
        if(r.ticks>=DX_FREE_MAX_TICKS)r.collected=true;
        if(j.status==='running'&&j.stats.kept>=j.target)break}
      // start runs, a few at a time (paid provider only)
      const active=j.runs.filter(r=>r.kind!=='free'&&['READY','RUNNING'].includes(r.status)).length;
      for(const r of j.runs.filter(r=>r.kind!=='free'&&r.status==='PENDING').slice(0,Math.max(0,DX_MAX_RUNNING-active))){
        try{const d=(await apify(`/acts/${encodeURIComponent(actorFor('tiktok'))}/runs?maxItems=${r.max}&timeout=3600`,
            {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(r.input)})).data;
          r.id=d.id;r.ds=d.defaultDatasetId;r.status=d.status||'READY';j.providerErr=null;dxLog(j,'Started '+r.label.slice(0,60))}
        catch(e){r.status='FAILED';r.err=e.message;j.providerErr=e.message;dxLog(j,'Could not start: '+e.message.slice(0,120))}}
      // collect from every started run, even while it is still running
      for(const r of j.runs.filter(r=>r.kind!=='free'&&r.id&&!r.collected)){
        try{const d=(await apify(`/actor-runs/${r.id}`)).data;r.status=d.status;r.ds=r.ds||d.defaultDatasetId}catch(e){}
        let pages=0;
        while(pages<DX_PAGES_PER_TICK){
          const items=await apify(`/datasets/${r.ds}/items?clean=true&offset=${r.offset}&limit=${DX_PAGE}&fields=${DX_FIELDS}`);
          const list=Array.isArray(items)?items:[];
          if(list.length)await dxIngest(j,list,r);
          r.offset+=list.length;r.rows+=list.length;j.stats.rows+=list.length;pages++;
          if(list.length<DX_PAGE)break}
        if(['SUCCEEDED','FAILED','ABORTED','TIMED-OUT'].includes(r.status)){
          const tail=await apify(`/datasets/${r.ds}/items?clean=true&offset=${r.offset}&limit=${DX_PAGE}&fields=${DX_FIELDS}`).catch(()=>[]);
          if(Array.isArray(tail)&&tail.length){await dxIngest(j,tail,r);r.offset+=tail.length;r.rows+=tail.length;j.stats.rows+=tail.length}
          else r.collected=true}
        if(j.status==='running'&&j.stats.kept>=j.target)break}
      // harvest-only bookkeeping: reaching the target, and handing off to triage
      if(j.status==='running'){
        if(j.stats.kept>=j.target){
          for(const r of j.runs.filter(r=>r.kind!=='free'&&['READY','RUNNING'].includes(r.status))){
            try{await apify(`/actor-runs/${r.id}/abort`,{method:'POST'})}catch(e){}r.status='ABORTED';r.collected=true}
          j.runs.filter(r=>r.kind!=='free'&&r.status==='PENDING').forEach(r=>{r.status='SKIPPED';r.collected=true});
          j.runs.filter(r=>r.kind==='free'&&!r.collected).forEach(r=>{r.collected=true});
          dxLog(j,`Target reached — ${num(j.stats.kept)} creators${j.stats.free?` (${num(j.stats.free)} free)`:''}. Remaining runs stopped.`)}
        const open=j.runs.filter(r=>!r.collected&&!['FAILED','SKIPPED'].includes(r.status));
        if(!open.length){j.status='scoring';j.collectedAt=new Date().toISOString();
          dxLog(j,`Harvest done — ${num(j.stats.rows+j.stats.free)} posts read (${num(j.stats.free)} free), ${num(j.stats.kept)} creators kept.`);
          emit('discovery_harvested',{job:j.id,rows:j.stats.rows,free:j.stats.free,kept:j.stats.kept,added:j.stats.added,cost_usd:+(j.stats.rows*DX_ROW_COST).toFixed(2)})}}
    }
    if(j.status==='scoring'){
      /* Scoring must never finish silently at 0 just because the AI backend
         hadn't confirmed itself ready on this one tick (e.g. checkBackend()
         was still in flight right as harvesting ended). Only "no candidates
         left to triage" or "hit the cap" count as actually done — an offline
         backend just waits for the next tick and tries again. */
      if(!aiReady()){
        j.notReadyTicks=(j.notReadyTicks||0)+1;
        if(j.notReadyTicks===1||j.notReadyTicks%8===0)dxLog(j,'Waiting for the AI backend to come online before triaging…');
        if(j.notReadyTicks>60){ // ~8 min of genuinely no AI: stop waiting, but say so honestly
          j.status='done';j.doneAt=new Date().toISOString();
          dxLog(j,`Done — AI backend never came online, 0 of ${num(j.stats.kept)} creators were reviewed. Results are unfiltered.`);
          emit('discovery_done',{job:j.id,kept:j.stats.kept,scored:j.stats.scored,ai_offline:true})}
      }else{
        j.notReadyTicks=0;
        const done=await dxTriageSome(j,6);
        if(done===0){
          if(j.toDeep&&j.toDeep.length){
            j.status='deepening';j.deepenQueued=false;
            dxLog(j,`Triage done — ${num(j.toDeep.length)} of ${num(j.stats.triaged)} moving to deep review, ${num(j.stats.triageRejected||0)} ruled out.`)
          }else{
            j.status='done';j.doneAt=new Date().toISOString();
            dxLog(j,`Done — ${num(j.stats.triaged)} triaged, none cleared the first pass.`);
            emit('discovery_done',{job:j.id,kept:j.stats.kept,scored:j.stats.scored});
            dxCfg().history=[{id:j.id,brief:j.brief,at:j.doneAt,kept:j.stats.kept,scored:j.stats.scored,rows:j.stats.rows},...(dxCfg().history||[])].slice(0,20)}}}}
    if(j.status==='deepening'){
      if(!aiReady()){
        j.notReadyTicks=(j.notReadyTicks||0)+1;
        if(j.notReadyTicks===1||j.notReadyTicks%8===0)dxLog(j,'Waiting for the AI backend to come online for the deep review…');
      }else{
        j.notReadyTicks=0;
        // fetch fresh posts for the shortlist once, then wait for those runs before scoring
        if(!j.deepenQueued){j.deepenQueued=true;await dxQueueDeepen(j);save()}
        const openDeepenRuns=j.runs.some(r=>r.key&&r.key.startsWith('p')&&!r.collected&&!['FAILED','SKIPPED'].includes(r.status));
        if(!openDeepenRuns){
          const done=await dxDeepScoreSome(j,4);
          if(done===0){
            j.status='done';j.doneAt=new Date().toISOString();
            dxLog(j,`Done — ${num(j.stats.scored)} creators reviewed in depth by Sonnet.`);
            emit('discovery_done',{job:j.id,kept:j.stats.kept,scored:j.stats.scored});
            dxCfg().history=[{id:j.id,brief:j.brief,at:j.doneAt,kept:j.stats.kept,scored:j.stats.scored,rows:j.stats.rows},...(dxCfg().history||[])].slice(0,20)}}}}
    if(j.status==='done'&&!j.listId&&typeof dxSaveJobAsList==='function'){try{await dxSaveJobAsList(j)}catch(e){dxLog(j,'Could not save list: '+e.message.slice(0,120))}}
  }catch(e){dxLog(j,'Error: '+e.message.slice(0,160))}
  finally{dxBusy=false;save();dxRenderJob()}}

/* ── Turn a completed job's AI-approved creators into a permanent, named list ──
   This is the canonical result of a Discover search: nothing else keeps the
   creators around once the job slot is reused by the next search. */
async function dxSaveJobAsList(j){
  if(typeof idbQuery!=='function'||typeof idbGetMany!=='function'||typeof saveList!=='function')return null;
  const keys=await idbQuery({platform:'tiktok',job:j.id,minFit:55,noFlags:true});
  const recs=(await idbGetMany(keys.map(k=>k.id))).filter(Boolean);
  if(!recs.length){dxLog(j,'No creator cleared the bar for this search — nothing to save.');return null}
  const name=(j.plan&&j.plan.persona?j.plan.persona:j.brief).slice(0,60)||('Search '+j.id);
  const list=await saveList(name,recs,{
    source:'discovery',jobId:j.id,platform:'tiktok',
    note:j.brief!==name?String(j.brief||'').slice(0,200):'',
    summary:(j.plan&&j.plan.persona)?j.plan.persona:'',
    filters:{min:j.min,max:j.max,market:j.market}});
  if(list){
    j.listId=list.id;
    const hist=dxCfg().history||[];
    const h=hist.find(x=>x.id===j.id);if(h)h.listId=list.id;
    dxLog(j,`Saved as list "${list.name}" — ${num(list.items.length)} creator(s).`);
    emit('discovery_saved_list',{job:j.id,listId:list.id,count:list.items.length})}
  return list}

/* ── 2–3. INGEST: fold posts by author, filter, merge into the index ───── */
function dxLangOf(t){try{return detectLang(t||'')}catch(e){return null}}
async function dxIngest(j,items,run){
  const neg=(j.plan.negative||[]).map(s=>s.toLowerCase()).filter(Boolean);
  const recs=[];
  for(const x of items){
    if(!x||x.error||!x.authorMeta)continue;
    const r=normalise('tiktok',x);if(!r)continue;
    j.stats.seen++;
    if((j.min&&r.subs<j.min)||(j.max&&r.subs>j.max)){j.stats.outBand++;continue}
    if(j.lang){const pl=String(x.textLanguage||'').slice(0,2);
      const bl=dxLangOf(r.bio);
      if(pl&&pl!=='un'&&pl!==j.lang&&(!bl||bl!==j.lang)){j.stats.wrongLang++;continue}}
    if(neg.length){const hay=(r.bio+' '+r.name+' '+r.handle).toLowerCase();if(neg.some(w=>hay.includes(w))){j.stats.negative++;continue}}
    const tag=(x.searchHashtag&&x.searchHashtag.name)||x.searchQuery||'';
    r.kw=tag?(run.kind==='hashtags'?'#':'')+tag:run.label.split(', ')[0];
    r.job=j.id;r.src='dx';
    recs.push(r)}
  if(!recs.length)return;
  const res=await dxUpsert(foldByCreator(recs),j);
  j.stats.added+=res.added;j.stats.kept+=res.added+res.newToJob;
  /* Queue every creator this job touched for AI review — a job-scoped list kept
     in memory, so scoring never has to re-scan the whole lead index (which only
     grows across every search ever run) just to find its own unscored rows. */
  if(!j.toScore)j.toScore=[];
  const known=new Set(j.toScore);
  res.merged.forEach(r=>{
    // a creator met again through a second hashtag after already being scored
    // (e.g. their record now carries more posts) does not need re-reviewing
    if(!known.has(r.id)&&!(r.ai&&r.ai.job===j.id)){j.toScore.push(r.id);known.add(r.id)}})}

/* Merge posts with what the index already knows, so a creator met in five
   hashtags ends up with five posts and a real median. */
async function dxUpsert(recs,j){
  const d=await idb();let added=0,newToJob=0;
  const merged=await new Promise((res,rej)=>{const t=d.transaction(STORE,'readwrite'),s=t.objectStore(STORE),out=[];
    recs.forEach(r=>{const g=s.get(r.id);g.onsuccess=()=>{const o=g.result;let n;
      if(!o){n=r;added++}
      else{const seen=new Set((o.posts||[]).map(p=>p.at+'|'+p.views));
        const posts=(o.posts||[]).concat((r.posts||[]).filter(p=>!seen.has(p.at+'|'+p.views))).slice(-16);
        n={...o,posts,subs:r.subs||o.subs,bio:o.bio||r.bio,email:o.email||r.email,links:{...(r.links||{}),...(o.links||{})},
          hits:(o.hits||1)+1,kw:o.kw||r.kw,thumb:o.thumb||r.thumb,seenAt:Date.now()};
        if(o.job!==j.id){n.job=o.job||j.id;if(!o.jobs||!o.jobs.includes(j.id)){n.jobs=[...(o.jobs||[]),j.id];newToJob++}}}
      const f=foldByCreator([{...n,hits:n.hits}])[0];f.hits=n.hits;s.put(f);out.push(f)}});
    t.oncomplete=()=>res(out);t.onerror=()=>rej(t.error)});
  if(recs.length)emit('leads_saved',{added,seen:recs.length,platform:'tiktok',keyword:'discovery engine'});
  return {added,newToJob,merged}}

/* ── 4. TRIAGE: Haiku throws out the clear no's, fast and cheap ─────────── */
function dxRow(r){
  const caps=(r.posts||[]).slice(-3).map(p=>String(p.caption||'').replace(/\s+/g,' ').slice(0,110)).filter(Boolean);
  return {h:r.handle,f:r.subs,mv:r.medViews||0,n:(r.posts||[]).length,e:r.engage||0,
    bio:String(r.bio||'').slice(0,160),cap:caps,lang:r.lang||'',reg:r.country||'',sp:r.sponsored||0,mail:r.email?1:0}}
/* The deep pass gets more to read — up to 8 captions instead of 3, backed by
   the extra posts dxQueueDeepen fetches for exactly this shortlist. */
function dxRowDeep(r){
  const caps=(r.posts||[]).slice(-8).map(p=>String(p.caption||'').replace(/\s+/g,' ').slice(0,140)).filter(Boolean);
  return {h:r.handle,f:r.subs,mv:r.medViews||0,n:(r.posts||[]).length,e:r.engage||0,
    bio:String(r.bio||'').slice(0,220),cap:caps,lang:r.lang||'',reg:r.country||'',sp:r.sponsored||0,mail:r.email?1:0}}

/* Pulled straight from the job's own queue — built once as creators are
   ingested (see dxIngest) — never a re-scan of the whole lead index. That
   queue is what makes reviewing every single kept creator (not just a
   capped top-N) affordable at 10,000+ scale. */
async function dxCandidates(ids){
  const recs=await idbGetMany(ids);
  return recs.filter(Boolean)}

async function dxTriageSome(j,batches){
  if(!batches)return 0;
  if(!j.toScore||!j.toScore.length)return 0;
  const want=batches*DX_TRIAGE_BATCH;
  const ids=j.toScore.slice(0,want);
  const cands=(await dxCandidates(ids)).filter(r=>!(r.dxTriage&&r.dxTriage.job===j.id));
  // whether triaged, errored, or already gone, these ids are done with this queue
  j.toScore=j.toScore.slice(ids.length);
  if(!cands.length)return j.toScore.length?1:0; // keep ticking if more remain
  const groups=[];for(let i=0;i<cands.length;i+=DX_TRIAGE_BATCH)groups.push(cands.slice(i,i+DX_TRIAGE_BATCH));
  const results=await Promise.all(groups.map(g=>dxTriageCall(j,g)));
  await dxWriteTriage(j,results);
  return cands.length}

async function dxTriageCall(j,group){
  const task=`TRIAGE — first pass, be fast and permissive
Brief: """${String(j.brief).slice(0,400)}"""
Ideal creator: ${j.plan.persona||''}

Throw out only the clear no's: "brand" (a company/store account, not a person), "wrong_niche" (bio and
captions show a completely different, unrelated activity — not just a lighter or adjacent version of the
brief), "kids" (likely under 18 or a kids'-content account), "adult", "repost" (aggregator/meme/repost page).
Everything else — including anything you are unsure about — passes with a mid-range fit; a slower, stricter
reviewer checks the survivors properly next. Do not reject for weak reach, thin bio, or a merely generic caption.

Creators (JSON lines):
${group.map(r=>JSON.stringify(dxRow(r))).join('\n')}

JSON: {"results":[{"h":"@handle","fit":0,"niche":"","why":"","flags":[]}]}`;
  try{
    const out=await runJSON('dxTriage',task,Math.min(3000,group.length*45+150),'haiku');
    const byH={};(out.results||[]).forEach(x=>{if(x&&x.h)byH[String(x.h).toLowerCase().replace(/^@?/,'@')]=x});
    return {group,byH,ok:true}
  }catch(e){return {group,byH:{},ok:false,err:e.message}}}

async function dxWriteTriage(j,results){
  const errored=results.filter(r=>!r.ok);
  errored.forEach(()=>{j.stats.scoreErr++});
  if(errored.length)dxLog(j,`Triage batch failed: ${errored[0].err||'unknown error'}`.slice(0,160));
  if(!j.toDeep)j.toDeep=[];
  const known=new Set(j.toDeep);
  const d=await idb();
  await new Promise((res,rej)=>{const t=d.transaction(STORE,'readwrite'),s=t.objectStore(STORE);
    results.forEach(({group,byH,ok})=>{if(!ok)return;
      group.forEach(r=>{const x=byH[String(r.handle).toLowerCase()];if(!x)return;
        const fit=Math.max(0,Math.min(100,Math.round(+x.fit||0)));
        const flags=(Array.isArray(x.flags)?x.flags:[]).map(String).slice(0,6);
        r.dxTriage={job:j.id,fit,niche:String(x.niche||'').slice(0,40),flags,at:new Date().toISOString()};
        s.put(r);j.stats.triaged++;
        const rejected=flags.some(f=>/brand|wrong_niche|kids|adult|repost/.test(f));
        if(!rejected&&fit>=DX_TRIAGE_MIN&&!known.has(r.id)){j.toDeep.push(r.id);known.add(r.id)}
        else if(rejected||fit<DX_TRIAGE_MIN)j.stats.triageRejected=(j.stats.triageRejected||0)+1})});
    t.oncomplete=res;t.onerror=()=>rej(t.error)}).catch(e=>{dxLog(j,'Writing triage failed: '+e.message.slice(0,120))})}

/* ── 5. DEEPEN: fetch real recent posts for the shortlist only ──────────── */
async function dxQueueDeepen(j){
  const cands=(await dxCandidates(j.toDeep)).filter(r=>(r.posts||[]).length<6);
  if(!cands.length||!provToken())return 0;
  const top=cands.map(r=>r.handle.replace(/^@/,''));
  const co=(j.market||'').toUpperCase();
  for(let i=0;i<top.length;i+=100){const p=top.slice(i,i+100);
    j.runs.push({key:'p'+Date.now()+i,kind:'profiles',label:`recent posts · ${p.length} creators`,max:p.length*DX_DEEPEN_MAX_POSTS,
      input:{profiles:p,resultsPerPage:DX_DEEPEN_MAX_POSTS,profileSorting:'latest',excludePinnedPosts:true,...DX_OFF,...(co?{proxyCountryCode:co}:{})},
      status:'PENDING',offset:0,rows:0})}
  dxLog(j,`Fetching recent posts for ${top.length} shortlisted creator(s) before the deep review.`);
  return top.length}

/* Manual escape hatch kept for the UI button on a finished job: read more
   posts for the current best N (e.g. to refresh a list after new videos). */
async function dxDeepen(n){
  const j=dxJob();if(!j)return;
  const keys=await idbQuery({platform:'tiktok'});const pool=[];
  for(let i=0;i<keys.length;i+=500){(await idbGetMany(keys.slice(i,i+500).map(k=>k.id)))
    .forEach(r=>{if(r&&(r.job===j.id||(r.jobs||[]).includes(j.id))&&(r.posts||[]).length<6)pool.push(r)})}
  pool.sort((a,b)=>(b.score||0)-(a.score||0));
  const top=pool.slice(0,n).map(r=>r.handle.replace(/^@/,''));
  if(!top.length)return 0;
  const co=(j.market||'').toUpperCase();
  for(let i=0;i<top.length;i+=100){const p=top.slice(i,i+100);
    j.runs.push({key:'p'+Date.now()+i,kind:'profiles',label:`recent posts · ${p.length} creators`,max:p.length*10,
      input:{profiles:p,resultsPerPage:10,profileSorting:'latest',excludePinnedPosts:true,...DX_OFF,...(co?{proxyCountryCode:co}:{})},
      status:'PENDING',offset:0,rows:0})}
  j.status='running';dxLog(j,`Reading recent posts for the top ${top.length}.`);save();dxStartLoop();dxRenderJob();return top.length}

/* ── 6. DEEP SCORE: Sonnet gives the final, strict verdict — shortlist only ── */
async function dxDeepScoreSome(j,batches){
  if(!batches)return 0;
  if(!j.toDeep||!j.toDeep.length)return 0;
  const want=batches*DX_DEEP_BATCH;
  const ids=j.toDeep.slice(0,want);
  const cands=(await dxCandidates(ids)).filter(r=>!(r.ai&&r.ai.job===j.id));
  j.toDeep=j.toDeep.slice(ids.length);
  if(!cands.length)return j.toDeep.length?1:0;
  const groups=[];for(let i=0;i<cands.length;i+=DX_DEEP_BATCH)groups.push(cands.slice(i,i+DX_DEEP_BATCH));
  /* The AI calls are the slow, network-bound part — those run concurrently.
     Writing the results back is local and fast, and must not open one
     IndexedDB transaction per group: many small concurrent transactions
     against the same store serialise and pile up, and just slow everything
     down for no benefit. One shared transaction commits every group's
     results together instead. */
  const results=await Promise.all(groups.map(g=>dxDeepScoreCall(j,g)));
  await dxWriteDeepScores(j,results);
  return cands.length}

async function dxDeepScoreCall(j,group){
  const task=`SCORER — final, strict pass on a pre-shortlisted candidate
Brief: """${String(j.brief).slice(0,600)}"""
Ideal creator: ${j.plan.persona||''}
Market: ${j.market||'any'} (${j.lang||'any language'}). Followers band ${num(j.min)}–${num(j.max)}.

Be strict. This creator already cleared a fast first pass — that pass only removed obvious mismatches, it did
not confirm a real fit, so judge them exactly as if seeing them for the first time. cap[] holds their actual
recent captions and bio is their actual bio: judge ONLY what those texts actually show, never what the search
keyword or hashtag implies. If the captions and bio do not clearly, concretely demonstrate the brief's
activity/niche (not just an adjacent or vaguely-related topic), score below 40 and set the "wrong_niche" flag —
a lifestyle/fashion/beauty/travel/vlog creator who happens to have posted under a fitness-adjacent tag is
wrong_niche, not a weak match. Prefer a false "no" to a false "yes".

The brief may also state tone, values, or things the brand will not be associated with (e.g. "no alcohol or
gambling content", "family-friendly only", "no political content", "body-positive messaging only"). Treat
every such statement as a hard requirement, not a preference: if anything in the captions or bio contradicts
it, or a required tone/value is simply absent from what they actually post, score below 40 and set the
"values_mismatch" flag, exactly like a niche mismatch. Do not soften this because the creator is otherwise a
strong niche fit — a values violation disqualifies on its own.

Score each creator 0–100 for how well they fit the brief as a paid-per-view partner:
niche match first (strictly, from actual bio and caption text), then any stated values/tone requirements
(strictly), then audience/market match, then reach (mv = median views seen, f = followers). With up to 8
recent captions to read (cap[]), judge on the pattern across them, not one post in isolation — an occasional
off-brief video from an otherwise consistent creator is not disqualifying on its own.
Flags when true: "brand" (a company, not a person), "wrong_niche" (captions/bio don't actually show the brief's
activity), "values_mismatch" (violates or lacks a stated tone/value requirement), "wrong_market", "kids"
(likely under 18 or kid audience), "adult", "repost" (aggregator/meme/repost page), "inactive".
"niche": 1–3 words describing what this creator ACTUALLY posts about. "why": under 12 words, must cite something
concrete from cap[] or bio, not the search keyword.

Creators (JSON lines):
${group.map(r=>JSON.stringify(dxRowDeep(r))).join('\n')}

JSON: {"results":[{"h":"@handle","fit":0,"niche":"","why":"","flags":[]}]}`;
  try{
    const out=await runJSON('scout',task,Math.min(4000,group.length*90+200),'sonnet');
    const byH={};(out.results||[]).forEach(x=>{if(x&&x.h)byH[String(x.h).toLowerCase().replace(/^@?/,'@')]=x});
    return {group,byH,ok:true}
  }catch(e){return {group,byH:{},ok:false,err:e.message}}}

/* Applies every group's AI verdicts in ONE IndexedDB transaction, however many
   groups were scored concurrently. */
async function dxWriteDeepScores(j,results){
  const errored=results.filter(r=>!r.ok);
  errored.forEach(()=>{j.stats.scoreErr++});
  if(errored.length)dxLog(j,`Deep review batch failed: ${errored[0].err||'unknown error'}`.slice(0,160));
  const d=await idb();
  await new Promise((res,rej)=>{const t=d.transaction(STORE,'readwrite'),s=t.objectStore(STORE);
    results.forEach(({group,byH,ok})=>{if(!ok)return;
      group.forEach(r=>{const x=byH[String(r.handle).toLowerCase()];if(!x)return;
        const fit=Math.max(0,Math.min(100,Math.round(+x.fit||0)));
        r.ai={job:j.id,fit,niche:String(x.niche||'').slice(0,40),why:String(x.why||'').slice(0,120),
          flags:(Array.isArray(x.flags)?x.flags:[]).map(String).slice(0,6),at:new Date().toISOString(),tier:'sonnet'};
        r.score=score(r);s.put(r);j.stats.scored++})});
    t.oncomplete=res;t.onerror=()=>rej(t.error)}).catch(e=>{dxLog(j,'Writing deep scores failed: '+e.message.slice(0,120))})}

async function dxStop(){const j=dxJob();if(!j)return;
  for(const r of j.runs.filter(r=>r.kind!=='free'&&['READY','RUNNING'].includes(r.status))){try{await apify(`/actor-runs/${r.id}/abort`,{method:'POST'})}catch(e){}r.status='ABORTED';r.collected=true}
  j.runs.filter(r=>r.kind!=='free'&&r.status==='PENDING').forEach(r=>{r.status='SKIPPED';r.collected=true});
  j.runs.filter(r=>r.kind==='free'&&!r.collected).forEach(r=>{r.collected=true});
  j.status='scoring';dxLog(j,'Stopped by you — triaging what was collected.');save();dxStartLoop();dxRenderJob()}
function dxPause(){const j=dxJob();if(!j)return;j.pausedFrom=j.status;j.status='paused';dxLog(j,'Paused');save();dxStopLoop();dxRenderJob()}
function dxResume(){const j=dxJob();if(!j)return;j.status=j.pausedFrom||'running';dxLog(j,'Resumed');save();dxStartLoop();dxTick();dxRenderJob()}

/* ── UI ────────────────────────────────────────────────────────────────── */
let dxPlanDraft=null;
function dxPanel(){
  const c=dxCfg(),j=c.job,ready=!!provToken();
  const active=j&&!['done'].includes(j.status);
  return `<div class="card">
    <div class="sh" style="margin-bottom:12px"><h2 style="font-size:19px">Find TikTok creators at scale</h2>
      <span class="pill ${ready?'g':''}">${ready?'Provider connected':'No provider token'}</span></div>
    <div class="cd" style="margin-bottom:14px">Describe who you want — including any tone or values a creator must (or must not) reflect. The AI plans the hashtags; every one is tried free first (real TikTok hashtag/sound pages, $0 per row) and only tops up with the paid provider for what the free tier didn't find. Every creator collected then gets a fast first pass; only the plausible ones get a slower, stricter final read before anything reaches the list. Nothing unqualified ever gets there, and nothing is padded to hit a number.</div>
    ${active?'':`
    <div class="fg"><label>Who are you looking for?</label>
      <textarea id="dx-b" style="min-height:70px" placeholder="Women doing gym and home workouts, sharing routines and what they eat — relatable, not pro athletes. No alcohol or gambling content, family-friendly tone only.">${esc(c.brief||'')}</textarea></div>
    <div class="fl">
      <div class="fg"><label>Market</label><select id="dx-m">${[['US','United States'],['GB','United Kingdom'],['CA','Canada'],['AU','Australia'],['FR','France'],['DE','Germany'],['ES','Spain'],['IT','Italy'],['BR','Brazil'],['','Anywhere']]
        .map(([v,n])=>`<option value="${v}" ${(c.market||'')===v?'selected':''}>${n}</option>`).join('')}</select></div>
      <div class="fg"><label>Min followers</label><input id="dx-mn" value="${num(c.min)}"></div>
      <div class="fg"><label>Max followers</label><input id="dx-mx" value="${num(c.max)}"></div>
      <div class="fg"><label>How many creators</label><select id="dx-t">${[1000,3000,5000,10000,25000].map(n=>`<option value="${n}" ${c.target===n?'selected':''}>${num(n)}</option>`).join('')}</select></div>
    </div>
    <div class="fl">
      <div class="fg" style="grid-column:span 2"><label>&nbsp;</label><div class="hd" style="padding-top:9px">Every creator collected gets a fast triage pass (≈$0.08 per 1,000) — only the ones it doesn't confidently reject get a slower, stricter final review with fresh posts fetched just for them. If the niche is smaller than what you asked for, you'll get everything that qualifies and nothing more.</div></div>
      <div class="fg"><label>&nbsp;</label><button class="btn p" style="width:100%" ${ready?'':'disabled'} onclick="dxDoPlan(this)">Plan the search</button></div>
    </div>
    ${dxPlanDraft?dxPlanView():''}`}
    <div id="dxJob">${j?dxJobView(j):''}</div>
    ${!active?dxHistoryView(c):''}
  </div>`}
/* Every past search, each one its own saved list — never merged with the next
   search, always retrievable on its own. */
function dxHistoryView(c){
  const hist=(c.history||[]).filter(h=>h.listId);
  if(!hist.length)return '';
  return `<div class="sh" style="margin-top:18px"><h2 style="font-size:15px">Past searches</h2></div>
    <div class="card"><table><thead><tr><th>Search</th><th class="r">Reviewed</th><th></th></tr></thead><tbody>
    ${hist.map(h=>`<tr>
      <td class="who">${esc(String(h.brief||'').slice(0,80))}<div class="hd">${new Date(h.at).toLocaleDateString()}</div></td>
      <td class="r">${num(h.scored)} of ${num(h.kept)}</td>
      <td class="r"><button class="btn sm" onclick="show('lists');openList='${h.listId}';renderLists()">View list</button></td>
    </tr>`).join('')}
    </tbody></table></div>`}

function dxReadForm(){const c=dxCfg();
  c.brief=$('dx-b').value.trim();c.market=$('dx-m').value;
  c.min=+$('dx-mn').value.replace(/[^0-9]/g,'')||0;c.max=+$('dx-mx').value.replace(/[^0-9]/g,'')||0;
  c.target=+$('dx-t').value;
  /* Every creator collected is reviewed by the AI — the review cap always tracks
     the target, it is never a separate, smaller number that quietly leaves part
     of the harvest unjudged. */
  c.scoreMax=c.target;save();return c}
async function dxDoPlan(btn){
  const c=dxReadForm();if(!c.brief){alert('Describe who you are looking for first.');return}
  btn.disabled=true;btn.innerHTML='<span class="spin"></span>Planning…';
  dxPlanDraft=await dxPlan(c.brief,c.market,c.target);renderDisc()}
function dxPlanView(){
  const p=dxPlanDraft,c=dxCfg(),b=dxBudget(p,c.target);
  return `<div class="panel" style="padding:16px 18px;margin-top:6px">
    <div class="sh"><b style="font-weight:500">Search plan ${p.source==='ai'?'· by Sonnet':'· basic (AI offline)'}</b>
      <span class="hd">${p.hashtags.length} hashtags · ${p.queries.length} searches · ~${num(b.rows)} posts to read</span></div>
    ${p.persona?`<div class="hd" style="margin-bottom:10px">${esc(p.persona)}</div>`:''}
    <div class="fg"><label>Hashtags (edit freely, one per line)</label><textarea id="dx-h" style="min-height:120px">${esc(p.hashtags.join('\n'))}</textarea></div>
    <div class="fg"><label>Video searches</label><textarea id="dx-q" style="min-height:60px">${esc(p.queries.join('\n'))}</textarea></div>
    ${p.negative&&p.negative.length?`<div class="hd" style="margin-bottom:10px">Excluded words: ${esc(p.negative.join(', '))}</div>`:''}
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
      <span>Estimated provider cost <b>$${b.cost.toFixed(2)}</b> at most — it stops as soon as ${num(c.target)} creators are found. Every hashtag is tried free first; this is the ceiling if the free tier finds nothing, not the typical cost.</span>
      <div style="display:flex;gap:8px"><button class="btn gh" onclick="dxPlanDraft=null;renderDisc()">Cancel</button>
      <button class="btn p" onclick="dxGo()">Launch</button></div></div></div>`}
function dxGo(){
  const c=dxReadForm();const split=v=>v.split(/\n+/).map(x=>x.trim()).filter(Boolean);
  const plan={...dxPlanDraft,hashtags:split($('dx-h').value).map(x=>x.replace(/^#/,'')),queries:split($('dx-q').value)};
  if(!plan.hashtags.length&&!plan.queries.length)return;
  dxNewJob(c.brief,c.market,plan);dxPlanDraft=null;renderDisc();dxLaunch()}

const DX_ST={planned:'Ready',running:'Harvesting',scoring:'Triage · Haiku',deepening:'Deep review · Sonnet',paused:'Paused',done:'Done'};
function dxJobView(j){
  const s=j.stats,runs=j.runs,fin=runs.filter(r=>r.collected||['FAILED','SKIPPED'].includes(r.status)).length;
  const pct=Math.min(100,Math.round(s.kept/Math.max(1,j.target)*100));
  const cost=(s.rows*DX_ROW_COST);
  const toDeepLeft=(j.toDeep||[]).length;
  return `<div class="panel" style="margin-top:12px"><div style="padding:16px 18px">
    <div class="sh"><div><b style="font-weight:500">${esc(DX_ST[j.status]||j.status)}</b> <span class="hd">· ${esc(String(j.brief).slice(0,90))}</span></div>
      <div style="display:flex;gap:6px">
        ${['running','scoring','deepening'].includes(j.status)?`<button class="btn sm gh" onclick="dxPause()">Pause</button>`:''}
        ${j.status==='paused'?`<button class="btn sm" onclick="dxResume()">Resume</button>`:''}
        ${j.status==='running'?`<button class="btn sm" onclick="if(confirm('Stop harvesting and triage what was found?'))dxStop()">Stop & triage</button>`:''}
        ${j.status==='done'?`<button class="btn sm" onclick="dxDeepen(500)">Read recent posts · top 500</button>
          ${j.listId?`<button class="btn sm p" onclick="show('lists');openList='${j.listId}';renderLists()">View saved list</button>`:''}
          <button class="btn sm gh" onclick="dxCfg().job=null;save();renderDisc()">New search</button>`:''}</div></div>
    <div class="bar"><i style="width:${pct}%"></i></div>
    ${j.providerErr&&!s.rows?`<div class="hd" style="color:var(--danger,#c0392b);margin:8px 0;padding:8px 10px;border:1px solid currentColor;border-radius:8px">Paid provider unavailable — every paid run failed to start: ${esc(String(j.providerErr).replace(/\s+/g,' ').slice(0,180))}${s.free?` Free tier still found ${num(s.free)} post(s).`:' Free tier found nothing for these hashtags yet either — they have been queued for the next free harvest pass (up to ~20 min).'}</div>`:''}
    <div class="pgrid" style="border:1px solid var(--line);border-radius:10px;overflow:hidden">
      <div class="pc"><div class="t">Creators kept</div><div class="big">${num(s.kept)}</div><div class="sm2">of ${num(j.target)} wanted · ${num(s.added)} new to your index</div></div>
      <div class="pc"><div class="t">Posts read</div><div class="big">${num(s.rows+(s.free||0))}</div><div class="sm2">${fin}/${runs.length} runs finished · ${num(s.free||0)} free · $${cost.toFixed(2)} so far</div></div>
      <div class="pc"><div class="t">Triaged · Haiku</div><div class="big">${num(s.triaged)}</div><div class="sm2">of ${num(s.kept)} kept · ${num(s.triageRejected||0)} ruled out${s.scoreErr?` · ${s.scoreErr} batch errors`:''}${aiReady()?'':' · AI offline'}</div></div>
      <div class="pc"><div class="t">Deep-reviewed · Sonnet</div><div class="big">${num(s.scored)}</div><div class="sm2">${toDeepLeft?`${num(toDeepLeft)} left in queue`:'shortlist only — the strictest pass'}</div></div>
    </div>
    <div class="hd" style="margin-top:10px">${(j.log||[]).slice(0,3).map(l=>esc(l.m)).join(' · ')}</div>
  </div></div>`}
function dxRenderJob(){const el=typeof document!=='undefined'&&$('dxJob');const j=dxJob();if(el&&j)el.innerHTML=dxJobView(j);
  if(j&&j.status==='done'&&!j.listed&&typeof loadPage==='function'){j.listed=true;try{page=0;loadPage()}catch(e){}}}

/* resume a job left running when the tab closed */
if(typeof window!=='undefined')setTimeout(()=>{(typeof stateReadyP!=='undefined'?stateReadyP:Promise.resolve()).then(()=>{
  const j=dxJob();if(j&&['running','scoring','deepening'].includes(j.status))dxStartLoop()})},0);
