// Discovery engine at 10,000+ creators, against a simulated provider and AI.  node test/test-discovery.js
const fs=require('fs'),path=require('path');const {JSDOM}=require('jsdom');const FIDB=require('fake-indexeddb');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
let pass=0,fail=0;const out=[];
const ok=(c,m)=>{if(c){pass++;out.push('  ✓ '+m)}else{fail++;out.push('  ✗ '+m)}};

/* ── a simulated TikTok: 60,000 authors, heavy-tailed followers ── */
function rng(seed){let s=seed;return()=>{s=(s*1103515245+12345)&0x7fffffff;return s/0x7fffffff}}
const R=rng(7);const AUTH=[];
for(let i=0;i<60000;i++){const u=R();const fans=Math.round(Math.exp(6+u*10.5));  // ~400 → ~15M
  const es=R()<0.12,shop=R()<0.04;
  AUTH.push({name:(shop?'fitshop':'fit')+i,nickName:'Creator '+i,fans,video:50+Math.round(R()*900),heart:fans*20,
    signature:shop?'Official store — shop now':(es?'entreno en casa y comida sana':'gym girl • home workouts • what I eat'),verified:false,_lang:es?'es':'en'})}
function fakeApify(){
  const runs={},dss={};let n=0;const A={runs,started:[],aborted:[],pulls:0,maxConcurrent:0};
  A.handle=(url,opts)=>{const u=new URL(url);const p=u.pathname.replace('/v2','');
    if(!u.searchParams.get('token'))return {ok:false,status:401,text:async()=>'no token'};
    let m;
    if((m=p.match(/^\/acts\/[^/]+\/runs$/))&&opts.method==='POST'){
      const input=JSON.parse(opts.body),id='run'+(++n),ds='ds'+n;const max=+u.searchParams.get('maxItems')||1e9;
      const units=input.hashtags||input.searchQueries||input.profiles||[];const per=input.resultsPerPage||10;const items=[];
      units.forEach((t,ti)=>{for(let k=0;k<per&&items.length<max;k++){
        const h=[...String(t)].reduce((a,c)=>a*31+c.charCodeAt(0)|0,7);
        const a=input.profiles?AUTH.find(x=>x.name===t)||AUTH[0]:AUTH[Math.abs(h*997+k*7919+ti)%AUTH.length];
        items.push({text:'my routine #'+t,textLanguage:a._lang,createTimeISO:new Date(Date.now()-k*864e5).toISOString(),
          playCount:Math.round(a.fans*(0.05+((k*37)%100)/200)),diggCount:100,commentCount:10,isSponsored:false,
          authorMeta:{...a},searchHashtag:input.hashtags?{name:t}:undefined,searchQuery:input.searchQueries?t:undefined,
          videoUrl:'x',musicMeta:{big:'x'.repeat(50)}})}});
      runs[id]={id,ds,status:'RUNNING',polls:0,input,max};dss[ds]={items,visible:Math.floor(items.length/2)};
      A.started.push(runs[id]);const live=Object.values(runs).filter(r=>r.status==='RUNNING').length;A.maxConcurrent=Math.max(A.maxConcurrent,live);
      return J({data:{id,status:'RUNNING',defaultDatasetId:ds}})}
    if((m=p.match(/^\/actor-runs\/([^/]+)$/))){const r=runs[m[1]];r.polls++;
      if(r.status==='RUNNING'&&r.polls>=2){r.status='SUCCEEDED';dss[r.ds].visible=dss[r.ds].items.length}
      return J({data:{id:r.id,status:r.status,defaultDatasetId:r.ds}})}
    if((m=p.match(/^\/actor-runs\/([^/]+)\/abort$/))){runs[m[1]].status='ABORTED';A.aborted.push(m[1]);return J({data:{}})}
    if((m=p.match(/^\/datasets\/([^/]+)\/items$/))){A.pulls++;A.lastFields=u.searchParams.get('fields');
      const d=dss[m[1]],off=+u.searchParams.get('offset'),lim=+u.searchParams.get('limit');
      const fields=(u.searchParams.get('fields')||'').split(',').filter(Boolean);
      return J(d.items.slice(off,Math.min(off+lim,d.visible)).map(x=>fields.length?Object.fromEntries(fields.filter(f=>f in x).map(f=>[f,x[f]])):x))}
    return {ok:false,status:404,text:async()=>'nope'}};
  return A}
const J=j=>({ok:true,status:200,headers:{get:()=>null},json:async()=>j,text:async()=>JSON.stringify(j)});

function fakeAI(aiOn){
  const F={calls:0,planCalls:0,scoreCalls:0,triageCalls:0,haikuCalls:0,sonnetCalls:0};
  F.handle=(body)=>{F.calls++;if(body.tier==='haiku')F.haikuCalls++;else F.sonnetCalls++;
    const t=body.messages[body.messages.length-1].content;
    if(/^PLANNER/.test(t)){F.planCalls++;const tags=[];for(let i=0;i<60;i++)tags.push(i%9===0?'#GymTok '+i:'fitgirl'+i);
      return J({content:[{type:'text',text:JSON.stringify({hashtags:tags,queries:['my gym routine','what i eat in a day','home workout for women'],
        negative:['official store'],persona:'Relatable women sharing gym and home workouts'})}],usage:{input_tokens:800,output_tokens:600}})}
    if(/^TRIAGE/.test(t)){F.triageCalls++;const rows=t.split('\n').filter(l=>l.startsWith('{"h"')).map(l=>JSON.parse(l));
      // coarse and permissive, but still rejects a real fraction: shop/brand accounts
      // always, plus roughly a fifth of the rest as an obvious niche mismatch —
      // enough to prove the shortlist is genuinely smaller than the full pool.
      const results=rows.map(r=>{const n=+r.h.replace(/\D/g,'');const shop=r.bio.includes('shop'),offNiche=!shop&&n%5===0;
        return {h:r.h,fit:shop?10:offNiche?25:60+(n%30),niche:'fitness',flags:shop?['brand']:offNiche?['wrong_niche']:[]}});
      return J({content:[{type:'text',text:JSON.stringify({results})}],usage:{input_tokens:900,output_tokens:400}})}
    if(/^SCORER/.test(t)){F.scoreCalls++;const rows=t.split('\n').filter(l=>l.startsWith('{"h"')).map(l=>JSON.parse(l));
      const results=rows.map(r=>{const n=+r.h.replace(/\D/g,'');return {h:r.h,fit:(n*37)%101,niche:'fitness',why:'gym routines, relatable',
        flags:r.bio.includes('shop')?['brand']:[]}});
      return J({content:[{type:'text',text:JSON.stringify({results})}],usage:{input_tokens:3000,output_tokens:1500}})}
    return J({content:[{type:'text',text:'{}'}],usage:{}})};
  return F}

/* freeQueue: {tag:[rawItem,...]} — a fake /api/free-pull backed by an
   in-memory queue per tag, drained the same way the real Redis-backed route
   is (up to `limit` per call, `more` true while something is left), so
   dxTick's free-tier polling exercises the exact same contract it does
   against the real backend. */
function fakeFreePull(freeQueue){
  return async(url)=>{const u=new URL(url,'https://x/');const tag=u.searchParams.get('tag');
    const limit=Math.max(1,Number(u.searchParams.get('limit'))||500);
    const q=freeQueue[tag]||[];const items=q.splice(0,limit);
    return J({ok:true,items,more:q.length>0})}}
function boot({ls,idb,aiOn=true,token=true,freeQueue}={}){
  const apx=fakeApify(),ai=fakeAI(aiOn),factory=idb||new FIDB.IDBFactory();
  const freePull=freeQueue&&fakeFreePull(freeQueue);
  let src=html;if(!token)src=src.replace(/const PROVIDER_TOKEN='[^']*'/,"const PROVIDER_TOKEN=''");
  const dom=new JSDOM(src,{runScripts:'dangerously',url:'https://cadence-app-amber.vercel.app/',pretendToBeVisual:true,
    beforeParse(w){w.__noTimers=true;w.indexedDB=factory;w.IDBKeyRange=FIDB.IDBKeyRange;
      w.alert=()=>{};w.confirm=()=>true;w.scrollTo=()=>{};w.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};
      if(ls)w.localStorage.setItem('cadence',ls);
      w.fetch=async(url,opts={})=>{url=String(url);
        if(url.startsWith('https://api.apify.com/'))return apx.handle(url,opts);
        if(url.endsWith('/api/health'))return J({ok:true,key:aiOn,storage:false,model:'claude-sonnet-5'});
        if(url.endsWith('/api/ai'))return ai.handle(JSON.parse(opts.body));
        if(freePull&&url.includes('/api/free-pull'))return freePull(url);
        return J({})}}});
  const w=dom.window;return {w,E:x=>w.eval(x),apx,ai,factory,close:()=>w.close()}}
async function runUntil(t,cond,max=400){for(let i=0;i<max;i++){if(t.E(cond))return i;await t.E('dxTick()')}return -1}

(async()=>{
  out.push('why the old search found 1 creator');
  ok(/searchSection:'\/user'/.test(html)&&/maxProfilesPerQuery:perKw/.test(html),'old path asked TikTok user search for 30 profiles per keyword — shallow, biggest accounts first (kept as "Manual keyword search (old)")');

  out.push('plan');
  {const t=boot();await t.E('stateReadyP');await new Promise(r=>setTimeout(r,20));
   t.E("dxCfg().target=10000;dxCfg().min=5000;dxCfg().max=500000;dxCfg().scoreMax=3000");
   const p=JSON.parse(await t.E("dxPlan('women doing gym and home workouts','US',10000).then(JSON.stringify)"));
   ok(p.source==='ai'&&p.hashtags.length===60&&p.queries.length===3,`Sonnet plans ${p.hashtags.length} hashtags + ${p.queries.length} searches from one line`);
   ok(p.hashtags.every(h=>/^[\p{L}\p{N}_]+$/u.test(h)),'hashtags cleaned (no #, no spaces)');
   const b=JSON.parse(t.E(`JSON.stringify(dxBudget(${JSON.stringify(p)},10000))`));
   ok(b.rows>=40000&&b.cost<200,`budget sized to the target: ~${b.rows.toLocaleString()} posts, $${b.cost} max`);
   t.close()}
  {const t=boot({aiOn:false});await t.E('stateReadyP');await new Promise(r=>setTimeout(r,20));
   const p=JSON.parse(await t.E("dxPlan('gym workouts for women','US',5000).then(JSON.stringify)"));
   ok(p.source==='fallback'&&p.hashtags.length>=10,'AI offline → a usable basic plan instead of nothing');t.close()}

  out.push('harvest 10,000+ creators');
  let saved;
  {const t=boot();await t.E('stateReadyP');await new Promise(r=>setTimeout(r,20));
   t.E("dxCfg().target=10000;dxCfg().min=5000;dxCfg().max=500000;dxCfg().scoreMax=3000");
   const t0=Date.now();
   await t.E("dxPlan('women doing gym and home workouts','US',10000).then(p=>{dxNewJob('women doing gym and home workouts','US',p);return dxLaunch()})");
   const first=t.apx.started[0];
   ok(first&&first.input.hashtags.length===8&&first.input.shouldDownloadVideos===false&&first.input.proxyCountryCode==='US','runs start async: 8 hashtags each, no media downloads, US proxy');
   ok(first.max===8*t.E('dxJob().per'),'each run capped with maxItems — never billed beyond the plan');
   // simulate a reload halfway through the harvest
   await runUntil(t,"dxJob().stats.kept>4000");
   const mid=JSON.parse(t.E("JSON.stringify(dxJob().stats)"));
   saved={ls:t.w.localStorage.getItem('cadence'),idb:t.factory,apx:t.apx};
   ok(t.apx.maxConcurrent<=4,`never more than 4 provider runs at once (${t.apx.maxConcurrent})`);
   ok(t.apx.lastFields&&t.apx.lastFields.includes('authorMeta')&&!t.apx.lastFields.includes('musicMeta'),'only the needed fields are downloaded');
   t.close();
   // reopen: same storage, same provider state
   const t2=boot({ls:saved.ls,idb:saved.idb});t2.apx.handle=saved.apx.handle;Object.assign(t2.apx,{started:saved.apx.started,aborted:saved.apx.aborted});
   await t2.E('stateReadyP');await new Promise(r=>setTimeout(r,20));
   ok(t2.E("dxJob().status")==='running'&&t2.E("dxJob().stats.kept")===mid.kept,`closing the tab loses nothing — job resumes at ${mid.kept.toLocaleString()} creators`);
   const it=await runUntil(t2,"['scoring','done'].includes(dxJob().status)");
   const s=JSON.parse(t2.E("JSON.stringify(dxJob().stats)"));const ms=Date.now()-t0;
   ok(it>=0&&s.kept>=10000,`${s.kept.toLocaleString()} creators kept (target 10,000) from ${s.rows.toLocaleString()} posts — in ${Math.round(ms/1000)}s of simulated run`);
   const skipped=t2.E("dxJob().runs.filter(r=>r.status==='SKIPPED'||r.status==='ABORTED').length");
   ok(skipped>0,`target reached → ${skipped} remaining runs stopped, no money spent on them`);
   ok(s.outBand>0&&s.wrongLang>0&&s.negative>0,`filters applied: ${s.outBand.toLocaleString()} outside band, ${s.wrongLang.toLocaleString()} wrong language, ${s.negative} excluded words`);
   const chk=JSON.parse(await t2.E(`(async()=>{const k=await idbQuery({platform:'tiktok'});const r=await idbGetMany(k.map(x=>x.id));
     return JSON.stringify({n:r.length,band:r.filter(x=>x.subs<5000||x.subs>500000).length,shop:r.filter(x=>/official store/i.test(x.bio)).length,
       multi:r.filter(x=>(x.posts||[]).length>1).length,withMv:r.filter(x=>x.medViews>0).length})})()`));
   ok(chk.n===s.kept&&chk.band===0&&chk.shop===0,`index holds exactly the kept creators, none outside the band, no excluded accounts (${chk.n.toLocaleString()})`);
   ok(chk.multi>1000&&chk.withMv===chk.n,`creators met in several hashtags are merged — ${chk.multi.toLocaleString()} have several posts; every one has a median`);

   out.push('AI ranking (queue mechanism, at harvest scale)');
   // At this scale, fully exhausting the review queue takes a while even in a
   // real deployment (the app deliberately caps concurrent Anthropic calls
   // app-wide, AI_MAX_PARALLEL, so nothing floods the API). Proving the queue
   // makes steady, uncapped progress here is enough; the smaller tests below
   // ("AI briefly offline…" and "results scoped…") already prove — quickly —
   // that scoring runs to completion with none skipped.
   const beforeScore=t2.E("dxJob().stats.triaged");
   const queueBefore=t2.E("(dxJob().toScore||[]).length");
   // the running→scoring transition already triages its first batch in the same
   // tick, so the queue plus what it already triaged should account for every
   // kept creator — none were ever capped out of the queue up front
   ok(queueBefore+beforeScore===s.kept,`the triage queue was seeded with every one of the ${s.kept.toLocaleString()} kept creators — no cap applied up front (${beforeScore.toLocaleString()} already triaged, ${queueBefore.toLocaleString()} queued)`);
   for(let i=0;i<8;i++)await t2.E('dxTick()');
   const afterScore=t2.E("dxJob().stats.triaged");
   const queueAfter=t2.E("(dxJob().toScore||[]).length");
   ok(afterScore>beforeScore&&queueAfter<queueBefore,`triage makes real progress against the queue (${beforeScore}→${afterScore} triaged, ${queueBefore.toLocaleString()}→${queueAfter.toLocaleString()} left)`);
   ok(t2.E("dxJob().status")==='scoring',"hasn't finished early — still reviewing, not just marking done");

   out.push('deepen the best');
   const n=await t2.E('dxDeepen(500)');
   ok(n===500&&t2.E("dxJob().runs.filter(r=>r.kind==='profiles').length")===5,'"Read recent posts · top 500" adds 5 profile runs of 100 for real medians');
   await runUntil(t2,"dxJob().status!=='running'",100);
   t2.E("show('discover')");t2.E("setPlat('tiktok')");
   const ui=t2.E("document.body.innerHTML");
   ok(ui.includes('Deep creator research')&&ui.includes('Legacy paid engine (Apify)')&&ui.includes('Find TikTok creators at scale')&&ui.includes('Deep-reviewed'),'Discover → TikTok leads with the AI research chat; the paid engine and old search are folded away');
   t2.close()}

   out.push('two-tier review: Haiku triages everyone, Sonnet only judges the shortlist')
   {const t3=boot();await t3.E('stateReadyP');await new Promise(r=>setTimeout(r,20));
    t3.E("dxCfg().target=400;dxCfg().min=5000;dxCfg().max=500000;dxCfg().scoreMax=400");
    await t3.E("dxPlan('women doing gym and home workouts','US',400).then(p=>{dxNewJob('women doing gym and home workouts','US',p);return dxLaunch()})");
    await runUntil(t3,"dxJob().status==='done'",600);
    await new Promise(r=>setTimeout(r,20));
    const kept=t3.E("dxJob().stats.kept"),triaged=t3.E("dxJob().stats.triaged"),scored=t3.E("dxJob().stats.scored");
    ok(triaged===kept,`every kept creator gets the Haiku triage pass — none skipped (${triaged}/${kept})`);
    ok(scored>0&&scored<kept,`only a shortlist gets the Sonnet deep review, not the whole pool (${scored} of ${kept})`);
    // batch sizes differ on purpose (Haiku batches wider, Sonnet's richer prompt batches
    // smaller), so call counts alone aren't the right proxy — creators touched is
    ok(t3.ai.haikuCalls>0&&t3.ai.sonnetCalls>0&&triaged>scored,`Haiku touches every creator (${triaged}), Sonnet only the shortlist that survives it (${scored}) — ${t3.ai.haikuCalls} haiku call(s), ${t3.ai.sonnetCalls} sonnet call(s)`);
    const brandLeak=JSON.parse(await t3.E(`(async()=>{const k=await idbQuery({platform:'tiktok'});const r=await idbGetMany(k.map(x=>x.id));
      return JSON.stringify(r.filter(x=>/official store/i.test(x.bio)&&x.ai&&x.ai.job===dxJob().id).length)})()`));
    ok(brandLeak===0,'a shop/brand account rejected at triage never reaches the expensive Sonnet pass');
    t3.close()}

  out.push('safety');
  {const t=boot({token:false});await t.E('stateReadyP');await new Promise(r=>setTimeout(r,20));
   let err='';try{await t.E("apify('/acts/x/runs',{method:'POST'})")}catch(e){err=e.message}
   ok(/No provider token/.test(err)&&t.apx.started.length===0,'no provider token → nothing is called');t.close()}

  out.push('AI not yet confirmed ready when harvest finishes (regression: used to finish with 0 scored)');
  {const t=boot();await t.E('stateReadyP');await new Promise(r=>setTimeout(r,20));
   t.E("dxCfg().target=500;dxCfg().min=5000;dxCfg().max=500000;dxCfg().scoreMax=500");
   await t.E("dxPlan('women doing gym and home workouts','US',500).then(p=>dxNewJob('women doing gym and home workouts','US',p))");
   // simulate checkBackend() not having resolved yet the instant the job is launched —
   // harvesting itself never looks at aiReady(), only the scoring step does
   t.E("aiCfg().backend.key=false");
   await t.E('dxLaunch()');
   const it=await runUntil(t,"dxJob().status==='scoring'",300);
   ok(it>=0,'harvest finishes and hands off to scoring even with the AI backend not ready yet');
   await t.E('dxTick()');await t.E('dxTick()');await t.E('dxTick()');
   ok(t.E("dxJob().status")==='scoring'&&t.E("dxJob().stats.scored")===0,'stays in "scoring" and waits instead of finishing at 0 scored');
   ok(t.E("dxJob().log[0].m").includes('Waiting for the AI'),'says plainly that it is waiting on the AI backend');
   t.E("aiCfg().backend.key=true");
   const it2=await runUntil(t,"dxJob().status==='done'",300);
   ok(it2>=0&&t.E("dxJob().stats.scored")>0,`once the AI backend is back, scoring resumes and finishes (${t.E("dxJob().stats.scored")} scored)`);
   t.close()}

  out.push('finishing a search auto-saves its AI-approved creators as a distinct, permanent list');
  {const t=boot();await t.E('stateReadyP');await new Promise(r=>setTimeout(r,20));
   t.E("dxCfg().target=300;dxCfg().min=5000;dxCfg().max=500000;dxCfg().scoreMax=300");
   await t.E("dxPlan('women doing gym and home workouts','US',300).then(p=>{dxNewJob('women doing gym and home workouts','US',p);return dxLaunch()})");
   await runUntil(t,"dxJob().status==='done'",300);
   // dxSaveJobAsList runs at the tail of the same tick that flips status to 'done' —
   // give the (already-awaited) async save a moment to land before asserting on it
   await new Promise(r=>setTimeout(r,20));
   const listId=t.E("dxJob().listId");
   ok(!!listId,'the completed job carries the id of the list it was saved into');
   const list=JSON.parse(t.E(`JSON.stringify((db.lists||[]).find(l=>l.id==='${listId}'))`));
   ok(!!list,'a matching entry exists in db.lists');
   ok(list.source==='discovery'&&list.jobId===t.E("dxJob().id"),'the list records where it came from: a discovery search, tagged with that job id');
   ok(list.items.length>0&&list.items.every(it=>it.subs!==undefined&&it.tier),`every saved item carries its follower count and a deterministic tier (${list.items.length} creators)`);
   const hist=JSON.parse(t.E("JSON.stringify(dxCfg().history)"));
   ok(hist[0]&&hist[0].listId===listId,'the job history entry also points at the saved list');

   out.push('a second search does not merge into the first — each is its own list');
   t.E("dxCfg().job=null;save()");
   t.E("dxCfg().target=300;dxCfg().min=5000;dxCfg().max=500000;dxCfg().scoreMax=300");
   await t.E("dxPlan('men doing outdoor hiking gear reviews','US',300).then(p=>{dxNewJob('men doing outdoor hiking gear reviews','US',p);return dxLaunch()})");
   await runUntil(t,"dxJob().status==='done'",300);
   await new Promise(r=>setTimeout(r,20));
   const listId2=t.E("dxJob().listId");
   ok(!!listId2&&listId2!==listId,'the second search produced a second, distinct list rather than appending to the first');
   const listsCount=t.E("(db.lists||[]).length");
   ok(listsCount>=2,`both searches' results persist side by side (${listsCount} lists saved)`);
   t.close()}

  out.push('Étage 1 — free tier: every hashtag tried free before paying the provider for it');
  {const freeQueue={};
   const t=boot({freeQueue});await t.E('stateReadyP');await new Promise(r=>setTimeout(r,20));
   t.E("dxCfg().target=600;dxCfg().min=5000;dxCfg().max=500000;dxCfg().scoreMax=600");
   const p=JSON.parse(await t.E("dxPlan('women doing gym and home workouts','US',600).then(JSON.stringify)"));
   // seed the free queue for the first 5 hashtags with real-shaped, already-
   // adapted rows — exactly what the real /api/free-pull hands back (adapted
   // once, at intake, by api/free-intake.js) — so the whole distinct author
   // pool is inside the followers band and clears every filter.
   let n=0;p.hashtags.slice(0,5).forEach(tag=>{freeQueue[tag]=Array.from({length:40},()=>{n++;
     return {text:'my gym routine #'+tag,textLanguage:'en',createTimeISO:new Date().toISOString(),
       playCount:50000,diggCount:2000,commentCount:80,isSponsored:false,
       authorMeta:{name:'freegirl'+n,nickName:'Free Girl '+n,fans:20000,signature:'gym girl • home workouts',
         region:'US',avatar:'',verified:false,video:120,heart:500000},
       searchHashtag:{name:tag}}})});
   await t.E("dxNewJob('women doing gym and home workouts','US',"+JSON.stringify(p)+");dxLaunch()");
   await runUntil(t,"dxJob().stats.free>0||dxJob().status==='scoring'",60);
   const s1=JSON.parse(t.E("JSON.stringify(dxJob().stats)"));
   ok(s1.free>=150,`free-tier rows ingested through the same pipeline as paid ones (${s1.free} free rows, 5 hashtags × 40)`);
   ok(s1.kept>=150,`those free-sourced creators are kept and counted like any other (${s1.kept} kept so far)`);
   const freeRuns=t.E("dxJob().runs.filter(r=>r.kind==='free')");
   ok(t.E("dxJob().runs.filter(r=>r.kind==='free').length")===p.hashtags.length,'one free run queued per hashtag in the plan, none skipped up front');
   const drainedCount=t.E("dxJob().runs.filter(r=>r.kind==='free'&&r.collected).length");
   ok(drainedCount>=5,`the seeded hashtags' free runs finish draining on their own (${drainedCount} collected)`);
   await runUntil(t,"dxJob().status==='done'",400);
   const sEnd=JSON.parse(t.E("JSON.stringify(dxJob().stats)"));
   ok(sEnd.free>0&&sEnd.rows>0,`free and paid rows both contributed to the same job (${sEnd.free} free, ${sEnd.rows} paid)`);
   ok(sEnd.kept>=t.E('dxJob().target'),`still reaches the full target blending both sources (${sEnd.kept} kept, target ${t.E('dxJob().target')})`);
   t.close()}
  {// a free-pull failure (network down, endpoint 500, whatever) must never
   // stall or fail the job — it just leaves that hashtag entirely to the
   // paid path, exactly as if the free tier had found nothing for it.
   const t=boot();await t.E('stateReadyP');await new Promise(r=>setTimeout(r,20));
   t.w.fetch=(orig=>async(url,opts)=>{if(String(url).includes('/api/free-pull'))throw new Error('network down');return orig(url,opts)})(t.w.fetch);
   t.E("dxCfg().target=300;dxCfg().min=5000;dxCfg().max=500000;dxCfg().scoreMax=300");
   await t.E("dxPlan('women doing gym and home workouts','US',300).then(p=>{dxNewJob('women doing gym and home workouts','US',p);return dxLaunch()})");
   const it=await runUntil(t,"dxJob().status==='done'",400);
   ok(it>=0&&t.E("dxJob().stats.kept")>=300,'a broken free tier never blocks the harvest — the paid path alone still reaches target');
   t.close()}

  console.log(out.join('\n'));console.log(`\n${pass} passed, ${fail} failed`);process.exit(fail?1:0)
})().catch(e=>{console.log(out.join('\n'));console.error('CRASH',e);process.exit(2)});
