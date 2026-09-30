#!/usr/bin/env node
/* Deep creator research worker — one "machine" of a research job.
   Several of these run in parallel on GitHub Actions (free on a public repo,
   ~6 h per session, a different IP each), each leasing a shard of the same
   job through /api/research. They share: one priority queue of sources, one
   "seen" set (no creator is ever read twice), the job-wide target and budget,
   and the long-term creator base. All logic lives in research-core.mjs.

   Sources (all public, signed-out):
   - t:<hashtag>   hashtag feed            headless Chromium, ~60 posts
   - k:<keywords>  keyword discovery       TikTok /discover/<keywords> page, then web
                                           search (site:tiktok.com) → creators whose
                                           bios/captions match, hashtags or not
   - s:<id>|<t>    sound page              headless Chromium, videos using a sound the
                                           accepted creators share
   - @mentions     creators tagged by accepted creators (plain HTTP)
   - the creator base built by every previous search (Redis)
   Per creator: profile SSR, creator embed (10 latest videos), 3 video pages,
   bio-link page — plain HTTP, free.

   Env: CADENCE_URL, FREE_HARVEST_SECRET (header only), RESEARCH_RUN_MS. */
import * as C from './research-core.mjs';
let chromium=null; // playwright-core, loaded in main() so tests can inject a fake browser

const BASE=(process.env.CADENCE_URL||'').replace(/\/$/,'');
const SECRET=process.env.FREE_HARVEST_SECRET||'';
const RUN_MS=Number(process.env.RESEARCH_RUN_MS)||(5*3600+15*60)*1000;
const RUNNER=(process.env.GITHUB_RUN_ID||'local')+'-'+(process.env.GITHUB_RUN_ATTEMPT||'1')+'-'+(process.env.SHARD_SLOT||'0');
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const T0=Date.now();
const SPEED=Number(process.env.RESEARCH_SPEED)||1; // tests run the real loops, faster
const sleep=ms=>new Promise(r=>setTimeout(r,ms/SPEED));
const jitter=ms=>ms+Math.floor(Math.random()*ms*0.5);
const timeLeft=()=>RUN_MS-(Date.now()-T0)*SPEED;

/* ── app API ───────────────────────────────────────────────────────────── */
async function api(op,payload,tries=5){
  let last='';
  for(let i=0;i<tries;i++){
    try{const r=await fetch(`${BASE}/api/research?op=${op}`,{method:'POST',
        headers:{'content-type':'application/json','x-worker-secret':SECRET},body:JSON.stringify(payload||{})});
      const j=await r.json().catch(()=>({}));
      if(r.ok)return j;
      if(r.status===429||r.status>=500){last=`${r.status} ${JSON.stringify(j).slice(0,160)}`;
        if(j&&j.error&&j.error.type==='daily_cap')throw Object.assign(new Error(j.error.message),{budget:true});
        await sleep(Number(r.headers.get('retry-after'))*1000||2000*2**i);continue}
      throw new Error(`${op} ${r.status}: ${JSON.stringify(j).slice(0,200)}`)}
    catch(e){if(e.budget)throw e;last=e.message;await sleep(1500*2**i)}}
  throw new Error(`${op} failed: ${last}`)}

let S=null,BRIEF=null,JOB=null,SHARD=0;
const G={accepted:0,cost:0,target:0,budget:0,status:'running',planned:false,allDone:false,reportWritten:false};
const logBuf=[];
function log(m){console.log(m);logBuf.push(m)}

async function ai(tier,system,prompt,maxTokens){
  const payload={tier,max_tokens:maxTokens,system:[{type:'text',text:system,cache_control:{type:'ephemeral'}}],
    messages:[{role:'user',content:prompt+'\n\nReturn only one JSON object.'}]};
  const j=await api('ai',{payload},4);
  C.meter(S,tier,j.usage);
  const text=(j.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
  return C.parseJSON(text)}

/* ── shared dedupe: only the creators this machine is first to see ─────── */
async function claimFresh(handles){
  const want=[...new Set(handles)].filter(h=>h&&!S.seen[h]);
  if(!want.length)return new Set();
  const out=new Set();
  for(let i=0;i<want.length;i+=800){
    try{const r=await api('mark',{id:JOB.id,handles:want.slice(i,i+800)});(r.fresh||[]).forEach(h=>out.add(h))}
    catch(e){want.slice(i,i+800).forEach(h=>out.add(h))}} // storage hiccup: better a rare duplicate than a lost creator
  return out}

/* ── polite plain-HTTP reads ───────────────────────────────────────────── */
let lastHit=0,httpInflight=0,httpFails=0;
async function getText(url,{timeout=20000,tiktok=true,lang}={}){
  while(httpInflight>=4)await sleep(120);
  httpInflight++;
  try{
    if(tiktok){const gap=350-(Date.now()-lastHit);if(gap>0)await sleep(gap);lastHit=Date.now()}
    const ac=new AbortController();const to=setTimeout(()=>ac.abort(),timeout);
    const l=lang||(BRIEF&&BRIEF.languages[0])||'en';
    const r=await fetch(url,{signal:ac.signal,redirect:'follow',headers:{'user-agent':UA,'accept-language':`${l},en;q=0.8`,accept:'text/html,application/xhtml+xml'}});
    const t=await r.text();clearTimeout(to);
    return {status:r.status,text:t}}
  catch(e){return {status:0,text:'',err:e.message}}
  finally{httpInflight--}}

const cache=new Map();
async function readCreator(h){
  if(cache.has(h))return cache.get(h);
  const [p,e]=await Promise.all([getText(`https://www.tiktok.com/@${h}`),getText(`https://www.tiktok.com/embed/@${h}`)]);
  const out={prof:C.parseProfileHtml(p.text),emb:C.parseEmbedHtml(e.text,h)};
  if(!out.prof&&!out.emb)httpFails++;else httpFails=0;
  cache.set(h,out);if(cache.size>500)cache.delete(cache.keys().next().value);
  return out}

/* ── headless reads ────────────────────────────────────────────────────── */
let browser=null,ctx=null,emptyStreak=0,resets=0;
async function newContext(){
  if(ctx)await ctx.close().catch(()=>{});
  const lang=(BRIEF.languages[SHARD%Math.max(1,BRIEF.languages.length)]||'en');
  ctx=await browser.newContext({userAgent:UA,locale:lang==='en'?'en-US':`${lang}-${(BRIEF.markets[0]||lang).toUpperCase()}`,viewport:{width:1366,height:900}})}
async function capture(url,re,scrolls){
  const page=await ctx.newPage();const items=[];const seen=new Set();
  page.on('response',async r=>{if(!re.test(r.url()))return;
    try{const j=await r.json();for(const it of (j.itemList||j.item_list||[])){if(it&&it.id&&!seen.has(it.id)){seen.add(it.id);items.push(it)}}}catch(e){}});
  let html='';
  try{
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:40000});
    await sleep(jitter(3200));
    for(let i=0;i<scrolls;i++){
      for(const sel of ['[data-e2e="modal-close-inner-button"]','[data-e2e="modal-close-button"]']){try{const el=await page.$(sel);if(el)await el.click({timeout:800})}catch(e){}}
      await page.mouse.wheel(0,4500);await sleep(jitter(1500))}
    html=await page.content()}
  catch(e){log(`  ! ${url.slice(22,90)}: ${e.message.slice(0,90)}`)}
  finally{await page.close().catch(()=>{})}
  return {items,html}}

/* SSR JSON anywhere in a page → post-like objects with an author. */
function itemsFromHtml(html){
  const out=[];const seen=new Set();
  const blobs=[...String(html).matchAll(/<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
  const walk=o=>{if(!o||typeof o!=='object')return;
    if(o.author&&typeof o.author==='object'&&o.author.uniqueId&&o.id&&!seen.has(o.id)){seen.add(o.id);out.push(o)}
    for(const v of Object.values(o))if(v&&typeof v==='object')walk(v)};
  blobs.forEach(b=>{try{walk(JSON.parse(b))}catch(e){}});
  return out}
const handlesIn=t=>[...new Set([...String(t).replace(/%40/gi,'@').replace(/%2F/gi,'/').matchAll(/tiktok\.com\/@([A-Za-z0-9._]{2,30})/g)].map(m=>C.cleanHandle(m[1])))].filter(h=>h.length>1);

/* ── sources ───────────────────────────────────────────────────────────── */
async function feedToCandidates(label,items){
  const authors=items.map(it=>it&&it.author&&C.cleanHandle(it.author.uniqueId)).filter(Boolean);
  const fresh=await claimFresh(authors);
  const n=C.ingestFeed(S,BRIEF,label,items,fresh);
  // lite records for the creator base: everyone who passed the free gate
  fresh.forEach(h=>{if(S.cand[h])S.poolBuf.push(C.poolLite(h,S.cand[h]))});
  return n}

async function queueHandles(label,handles){
  const fresh=await claimFresh(handles);let n=0;
  fresh.forEach(h=>{if(!S.seen[h]){S.seen[h]='m';S.probeQ.push(h);n++}});
  let T=S.tags[label];if(!T)T=S.tags[label]={src:'shared',pri:50,st:'done',posts:0,authors:0,passed:0,acc:0};
  T.authors+=n;S.stats.sourcesDone=(S.stats.sourcesDone||0)+1;S.tagsSinceSupervise++;
  return n}

async function runHashtag(tag){
  const {items}=await capture(`https://www.tiktok.com/tag/${encodeURIComponent(tag)}`,/\/api\/challenge\/item_list\//,3);
  if(!items.length)return -1;
  const n=await feedToCandidates(tag,items);
  log(`#${tag}: ${items.length} posts, ${n} new creators`);return n}

async function runSound(key){
  const [id,title]=key.split('|');
  const slug=String(title||'sound').replace(/[^A-Za-z0-9]+/g,'-').replace(/^-|-$/g,'')||'sound';
  const {items}=await capture(`https://www.tiktok.com/music/${slug}-${id}`,/\/api\/music\/item_list\//,3);
  if(!items.length)return -1;
  const n=await feedToCandidates('s:'+id,items);
  log(`♪ ${title||id}: ${items.length} posts, ${n} new creators`);return n}

/* Keyword discovery — reaches creators who don't use predictable hashtags.
   TikTok's public SEO "keyword pages" (/discover/<words>) are backed by an
   unsigned JSON list of the videos TikTok itself ranks for those words — from
   captions, on-screen text and speech, hashtag or not — ~150 videos per
   keyword, plus related keywords (a free keyword graph to snowball on).
   A web search restricted to tiktok.com profiles is tried as a bonus when the
   search engine lets a datacenter IP through. */
const KAP='https://www.tiktok.com/api/seo/kap/';
let kapMode='http',kapPage=null,ddgOff=0;
const deaccent=s=>s.normalize('NFD').replace(/[\u0300-\u036f]/g,'');
const kapSlug=kw=>kw.trim().toLowerCase().replace(/[\s_]+/g,'-').replace(/[^\p{L}\p{N}-]/gu,'').replace(/-+/g,'-');
async function kapJSON(url){
  if(kapMode==='http'){
    const r=await getText(url,{lang:(BRIEF.languages[0]||'en')});
    try{return JSON.parse(r.text)}catch(e){kapMode='browser';log('Keyword lists: switching to in-browser reads for this machine.')}}
  try{
    if(!kapPage){kapPage=await ctx.newPage();await kapPage.goto('https://www.tiktok.com/discover/fitness',{waitUntil:'domcontentloaded',timeout:40000});await sleep(3000)}
    return await kapPage.evaluate(async u=>{const x=await fetch(u);return x.json().catch(()=>({}))},url)}
  catch(e){kapPage=null;return {}}}
async function kapVideos(slug,region){
  const out=[];
  for(let off=0;off<160;off+=16){
    const j=await kapJSON(`${KAP}video_list/?appId=1233&count=16&keyword=${encodeURIComponent(slug)}&pageType=7&region=${region}&trafficType=0&offset=${off}`);
    const l=Array.isArray(j.videoList)?j.videoList:[];out.push(...l);
    if(!l.length||!j.hasMore)break;
    await sleep(jitter(500))}
  return out}
function regionFor(kw){
  const l=C.detectLang(kw+' '+kw).lang;const m=BRIEF.markets;
  const byLang={fr:['FR','BE','CH','CA'],de:['DE','AT','CH'],es:['ES','MX'],it:['IT'],pt:['BR','PT'],nl:['NL','BE'],en:['US','GB','CA','AU']};
  return (l&&m.find(x=>(byLang[l]||[]).includes(x)))||m[0]||'US'}
async function runKeyword(kw){
  const label='k:'+kw;let total=0;
  let slug=kapSlug(kw),region=regionFor(kw);
  let items=await kapVideos(slug,region);
  if(!items.length&&deaccent(slug)!==slug){slug=deaccent(slug);items=await kapVideos(slug,region)}
  if(items.length)total+=await feedToCandidates(label,items.map(it=>({...it,textLanguage:it.textLanguage||C.detectLang(it.desc).lang})));
  // the keyword graph: TikTok's own related searches for this page
  if(items.length){
    const rk=await kapJSON(`${KAP}related_keywords/?appId=1233&count=60&keyword=${encodeURIComponent(slug)}&region=${region}&trafficType=0`);
    const rel=(rk.relatedKeywords||[]).map(x=>C.cleanKeyword(String(x.formattedWord||x.uniqueWord||'').replace(/-/g,' '))).filter(k=>k.length>3);
    if(rel.length)await pushSources(rel.slice(0,30).map(k=>({key:'k:'+k,pri:62})))}
  let hs=[];
  if(ddgOff<3){
    const web=await getText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(`site:tiktok.com "${kw}"`)}`,{tiktok:false});
    hs=handlesIn(web.text);ddgOff=hs.length?0:ddgOff+1}
  if(hs.length)total+=await queueHandles(label,hs);
  log(`🔎 "${kw}": ${items.length} videos${hs.length?` + ${hs.length} profiles from the web`:''} → ${total} new creators`);
  return items.length||hs.length?total:-1}

async function runSource(item){
  const [kind,...rest]=item.key.split(':');const val=rest.join(':');
  if(kind==='t')return runHashtag(val);
  if(kind==='k')return runKeyword(val);
  if(kind==='s')return runSound(val);
  return 0}

/* ── stages ────────────────────────────────────────────────────────────── */
let stop=false,shardStatus='',stopWhy='';
let supervising=false,aiBusy=0,localSources=[],queueDry=0;
const pendingResults=[];

async function pushSources(items){
  if(!items||!items.length)return 0;let n=0;
  for(let i=0;i<items.length;i+=250){try{const r=await api('src-add',{id:JOB.id,items:items.slice(i,i+250)});n+=r.added||0}catch(e){log('Could not queue sources: '+e.message.slice(0,80))}}
  return n}

async function plan(){
  log('Planning the search with Sonnet…');
  let out={};
  for(let i=0;i<2;i++){try{out=await ai('sonnet',C.PLAN_SYS,C.planPrompt(BRIEF),4000);break}catch(e){log('Planning answer unreadable, retrying: '+e.message.slice(0,80))}}
  C.applyPlan(S,BRIEF,out);
  const items=C.planItems(S);
  const n=await pushSources(items);
  BRIEF.example_creators.forEach(h=>{if(!S.seen[h]){S.seen[h]='m';S.probeQ.push(h)}});
  log(`Plan ready — ${n} sources queued (${Object.keys(S.tags).length} hashtags, ${(S.keywords||[]).length} keyword searches) for every machine.`);
  await checkpoint({plan:{disq:BRIEF._disq,persona:S.persona,keywords:S.keywords}})}

/* The creator base first: everyone already known who could fit, re-read for
   free (text match) and only then triaged — no crawling needed for them. */
async function scanPool(){
  const terms=C.poolTerms(S);if(!terms.length)return;
  let cursor='0',scanned=0,matched=0,guard=0;
  do{
    let r;try{r=await api('pool-scan',{cursor,count:800})}catch(e){break}
    cursor=r.cursor;scanned+=r.items.length;
    const hits=r.items.filter(rec=>rec&&rec.h&&!C.poolSkip(BRIEF,rec)&&C.poolRelevant(rec,terms));
    const fresh=await claimFresh(hits.map(x=>x.h));
    for(const rec of hits){if(!fresh.has(rec.h))continue;
      S.cand[rec.h]=C.fromPool(rec);S.seen[rec.h]='q';S.triageQ.push(rec.h);matched++}
  }while(cursor!=='0'&&++guard<200&&!stop);
  S.stats.poolHits=(S.stats.poolHits||0)+matched;
  if(scanned)log(`Creator base: ${scanned} known creators re-read, ${matched} match this brief and go straight to review.`)}

async function supervise(){
  if(supervising)return 0;supervising=true;
  try{const out=await ai('sonnet',C.SUP_SYS,C.supervisorPrompt(S,BRIEF,G.target||JOB.target),3000);
    const r=C.applySupervisor(S,out);
    const n=await pushSources(r.items);
    log(`Supervisor: ${r.note||'adjusted the search'} (+${n} sources)`);
    return n}
  catch(e){log('Supervisor step failed: '+e.message.slice(0,120));return 0}
  finally{supervising=false}}

async function nextSource(){
  S.localSources=localSources; // popped but not yet run: checkpointed, never lost
  if(!localSources.length){
    try{const r=await api('src-next',{id:JOB.id,n:2});localSources=r.items||[]}catch(e){return null}}
  return localSources.shift()||null}

async function browserLoop(slot){
  await sleep(slot*4000);
  while(!stop){
    if(S.triageQ.length>300||S.fetchQ.length>150||S.probeQ.length>200||S.deepQ.length+S.escalateQ.length>80){await sleep(3000);continue}
    const item=await nextSource();
    if(!item){queueDry++;await sleep(6000);continue}
    queueDry=0;
    let n;try{n=await runSource(item)}catch(e){log(`  ! ${item.key}: ${e.message.slice(0,90)}`);n=-1}
    if(n<0){
      emptyStreak++;
      if(emptyStreak>=6){resets++;emptyStreak=0;log(`TikTok returned nothing several times in a row — fresh browser session (${resets}).`);
        await newContext();await sleep(resets>3?120000:30000)}
    }else emptyStreak=0;
    if(S.tagsSinceSupervise>=C.LIMITS.SUPERVISE_EVERY_TAGS)supervise();
    await sleep(jitter(1800))}}

async function triageLoop(){
  while(!stop){
    const ready=S.triageQ.length>=C.LIMITS.TRIAGE_BATCH||(S.triageQ.length&&queueDry>1);
    if(!ready){await sleep(2500);continue}
    const batch=S.triageQ.splice(0,C.LIMITS.TRIAGE_BATCH).filter(h=>S.cand[h]);
    if(!batch.length)continue;
    aiBusy++;
    try{const out=await ai('haiku',C.TRIAGE_SYS,C.triagePrompt(BRIEF,batch,S),Math.min(4000,batch.length*55+200));
      const p=C.applyTriage(S,batch,out);
      log(`Triage: ${p} of ${batch.length} move on to a full dossier`)}
    catch(e){S.triageQ.unshift(...batch);log('Triage batch failed, will retry: '+e.message.slice(0,100));await sleep(8000)}
    finally{aiBusy--}}}

async function probeOne(h){
  const {prof,emb}=await readCreator(h);
  if(!prof&&!emb){S.seen[h]='e';return}
  const vids=(emb&&emb.videos)||[];
  const c={f:(prof&&prof.f)||(emb&&emb.user.f)||0,hearts:(prof&&prof.hearts)||0,vids:(prof&&prof.vids)||0,sig:(prof&&prof.bio)||(emb&&emb.user.bio)||'',
    nick:(prof&&prof.nick)||'',ver:!!(prof&&prof.ver),priv:!!((prof&&prof.priv)||(emb&&emb.user.priv)),avatar:(prof&&prof.avatar)||'',
    cap:vids.slice(-4).map(v=>v.desc),views:vids.map(v=>v.views),lang:[],via:['@mention']};
  const l=C.detectLang([c.sig,...vids.map(v=>v.desc)].join(' \n '));if(l.lang)c.lang=[l.lang];
  S.cand[h]=c;S.stats.authorsSeen++;
  const why=C.gate(BRIEF,c)||(BRIEF.strict_language&&BRIEF.languages.length&&l.conf>=0.6&&!BRIEF.languages.includes(l.lang)?'language: '+l.lang:'');
  S.poolBuf.push(C.poolLite(h,c));
  if(why){S.seen[h]='g';S.stats.gated++;S.reasons[why]=(S.reasons[why]||0)+1;delete S.cand[h]}else{S.seen[h]='q';S.triageQ.push(h)}}

async function dossierOne(h){
  const cand=S.cand[h];
  const {prof,emb}=await readCreator(h);
  if(!prof&&!emb){
    cand.retries=(cand.retries||0)+1;
    if(cand.retries<3)S.fetchQ.push(h);else{S.seen[h]='e';S.stats.dossierFail++;delete S.cand[h]}
    return}
  const vids=(emb&&emb.videos)||[];
  const m0=C.metrics(prof,emb,[]);
  const recent=vids.slice(m0.pinned).sort((a,b)=>b.at-a.at).slice(0,3);
  const vpages=[];
  for(const v of recent){const r=await getText(`https://www.tiktok.com/@${h}/video/${v.id}`);const p=C.parseVideoHtml(r.text);if(p)vpages.push(p)}
  const d=C.buildDossier(h,cand,prof,emb,vpages);
  S.stats.dossiers++;
  S.poolBuf.push(C.poolFull(d));
  const why=C.dossierGate(BRIEF,d);
  if(why){S.seen[h]='r';S.stats.rejected++;S.reasons['free check: '+why.replace(/: \w+$/,'')]=(S.reasons['free check: '+why.replace(/: \w+$/,'')]||0)+1;delete S.cand[h];return}
  S.dossiers[h]=d;S.deepQ.push(h);delete S.cand[h]}

async function fetchLoop(){
  while(!stop){
    if(S.deepQ.length+S.escalateQ.length>60){await sleep(2000);continue}
    if(httpFails>=12){log('Profile pages are not answering — pausing reads for 2 minutes.');httpFails=0;await sleep(120000);continue}
    let h=S.fetchQ.shift();
    if(h&&S.cand[h]){try{await dossierOne(h)}catch(e){S.seen[h]='e';delete S.cand[h]}continue}
    h=S.probeQ.shift();
    if(h){try{await probeOne(h)}catch(e){S.seen[h]='e'}continue}
    await sleep(1200)}}

async function finalize(d,v,tier){
  delete S.dossiers[d.handle];
  S.poolBuf.push(C.poolVet(d.handle,v));
  if(!v.accept){S.seen[d.handle]='r';S.stats.rejected++;const k='vetting: '+(v.flags[0]||v.verdict);S.reasons[k]=(S.reasons[k]||0)+1;return}
  let page='';
  if(d.bioLink&&/^https?:\/\//.test(d.bioLink)&&!/tiktok\.com/.test(d.bioLink)){const r=await getText(d.bioLink,{timeout:12000,tiktok:false});page=r.text.slice(0,400000)}
  const contacts=C.contactsFrom(d,page);
  S.poolBuf.push({...C.poolFull(d,contacts),...C.poolVet(d.handle,v)});
  if(BRIEF.contact_required&&!contacts.email&&!contacts.instagram){S.seen[d.handle]='r';S.stats.rejected++;S.reasons['no contact']=(S.reasons['no contact']||0)+1;return}
  S.seen[d.handle]='a';S.stats.accepted++;
  C.learnFromAccepted(S,d);
  pendingResults.push(C.resultRecord(d,v,contacts,tier));
  log(`✓ @${d.handle} — ${v.score}/100 · ${v.niche}${contacts.email?' · email':''}`)}

async function vetBatch(tier,handles){
  const ds=handles.map(h=>S.dossiers[h]).filter(Boolean);
  if(!ds.length)return;
  aiBusy++;
  try{
    const out=await ai(tier,C.VET_SYS,C.vetPrompt(BRIEF,ds),Math.min(4000,ds.length*330+200));
    const by={};(out.results||[]).forEach(r=>{if(r&&r.h)by[C.cleanHandle(r.h)]=r});
    for(const d of ds){
      const r=by[d.handle];
      if(!r){d.miss=(d.miss||0)+1;if(d.miss<3)(tier==='sonnet'&&BRIEF.quality==='balanced'?S.escalateQ:S.deepQ).push(d.handle);else delete S.dossiers[d.handle];continue}
      S.stats.vetted++;
      const v=C.readVerdict(r,BRIEF);
      if(C.needsEscalation(v,BRIEF,tier)){S.escalateQ.push(d.handle);S.stats.escalated++;continue}
      await finalize(d,v,tier)}}
  catch(e){(tier==='sonnet'&&BRIEF.quality==='balanced'?S.escalateQ:S.deepQ).unshift(...ds.map(d=>d.handle));
    log(`Vetting batch failed, will retry: ${e.message.slice(0,100)}`);await sleep(10000)}
  finally{aiBusy--}}

async function vetLoop(){
  while(!stop){
    const upstreamIdle=queueDry>1&&!S.triageQ.length&&!S.fetchQ.length&&!S.probeQ.length;
    if(BRIEF.quality==='balanced'&&(S.escalateQ.length>=C.LIMITS.DEEP_BATCH_SONNET||(S.escalateQ.length&&upstreamIdle&&!S.deepQ.length))){
      await vetBatch('sonnet',S.escalateQ.splice(0,C.LIMITS.DEEP_BATCH_SONNET));continue}
    const tier=BRIEF.quality==='max'?'sonnet':'haiku';
    const n=tier==='sonnet'?C.LIMITS.DEEP_BATCH_SONNET:C.LIMITS.DEEP_BATCH_HAIKU;
    if(S.deepQ.length>=n||(S.deepQ.length&&upstreamIdle)){await vetBatch(tier,S.deepQ.splice(0,n));continue}
    await sleep(2500)}}

/* ── checkpointing + control ───────────────────────────────────────────── */
function progressPatch(extra){
  S.stats.elapsedMs=(S.stats.elapsedMsBase||0)+(Date.now()-T0);
  const srcs=Object.entries(S.tags);
  return {stats:{...S.stats,queue:{triage:S.triageQ.length,dossier:S.fetchQ.length+S.probeQ.length,vetting:S.deepQ.length+S.escalateQ.length}},
    phase:G.planned?'searching':'planning',
    strategy:{persona:S.persona||JOB.persona||'',notes:S.notes.slice(-6),
      bestTags:srcs.filter(([,v])=>v.acc).sort((a,b)=>b[1].acc-a[1].acc).slice(0,15).map(([t,v])=>({t,acc:v.acc,authors:v.authors})),
      reasons:Object.entries(S.reasons).sort((a,b)=>b[1]-a[1]).slice(0,12)},
    ...(extra||{})}}
async function flush(){
  while(pendingResults.length){const part=pendingResults.splice(0,60);
    try{const r=await api('add',{id:JOB.id,creators:part});G.accepted=r.accepted||G.accepted}
    catch(e){pendingResults.unshift(...part);log('Could not store results yet: '+e.message.slice(0,80));return}}
  while(S.poolBuf.length){const part=S.poolBuf.splice(0,250);
    try{await api('pool-put',{creators:part})}catch(e){S.poolBuf.unshift(...part);return}}}
async function checkpoint(extra){
  await flush();
  const {poolBuf,...ck}=S;
  const r=await api('save',{id:JOB.id,shard:SHARD,patch:progressPatch(extra),ckpt:ck,log:logBuf.splice(0,logBuf.length)});
  Object.assign(G,{accepted:r.accepted,cost:r.costUsd,target:r.target,budget:r.budget||BRIEF.max_cost_usd,status:r.status,planned:r.planned,allDone:r.allDone,reportWritten:r.reportWritten});
  if(r.planned&&!BRIEF._disq){BRIEF._disq=r.disq;S.disq=r.disq;S.persona=S.persona||r.persona;S.keywords=S.keywords||r.keywords}
  return r}

async function controlLoop(){
  let lastSave=Date.now(),dry=0;
  while(!stop){
    await sleep(5000);
    if(G.accepted+pendingResults.length>=G.target){shardStatus='done';stopWhy=`Target reached — ${G.accepted+pendingResults.length} creators vetted and accepted.`;stop=true;break}
    if(G.cost>=G.budget){shardStatus='done';stopWhy=`AI budget for this search reached ($${G.cost.toFixed(2)}). Resume with a higher budget to keep going.`;stop=true;break}
    if(timeLeft()<4*60000){shardStatus='queued';stopWhy='Session time used — the next session continues from here automatically.';stop=true;break}
    const localIdle=!S.triageQ.length&&!S.fetchQ.length&&!S.deepQ.length&&!S.escalateQ.length&&!S.probeQ.length&&!aiBusy;
    if(queueDry>=3&&localIdle&&!supervising){
      dry++;
      if(dry>=2){const added=S.expansionsDry<3?await supervise():0;
        if(!added){S.expansionsDry++;if(S.expansionsDry>=3){shardStatus='done';stopWhy=`This machine ran out of leads — every promising source it could find has been explored.`;stop=true;break}}
        else{S.expansionsDry=0;queueDry=0}
        dry=0}}
    else dry=0;
    if(Date.now()-lastSave>45000){lastSave=Date.now();
      try{await checkpoint({shardStatus:'running'});
        if(G.status==='cancel_requested'){shardStatus='done';stopWhy='cancelled';stop=true}}
      catch(e){console.log('checkpoint failed: '+e.message)}}}}

async function finalReport(){
  try{
    const out=await ai('sonnet','You write short, concrete research reports for brand marketers. Answer only with the JSON asked for.',
      `BRIEF\n${C.briefText(BRIEF)}\n\nOUTCOME (this machine's view + job totals): ${G.accepted} creators accepted in total. This machine: ${S.stats.authorsSeen} creators seen, ${S.stats.triaged} triaged, ${S.stats.vetted} fully vetted, ${S.stats.poolHits||0} reused from the creator base. Most productive sources: ${Object.entries(S.tags).filter(([,v])=>v.acc).sort((a,b)=>b[1].acc-a[1].acc).slice(0,12).map(([t,v])=>`${t}(${v.acc})`).join(' ')}. Main rejection reasons: ${Object.entries(S.reasons).sort((a,b)=>b[1]-a[1]).slice(0,6).map(([r,n])=>r+' '+n).join('; ')}. Supervisor notes: ${S.notes.slice(-4).join(' | ')}.
Write {"report":"4-6 sentences in language '${BRIEF.summary_language}': what was found, where the best creators came from, what to know before outreach"}`,900);
    return String(out.report||'').slice(0,1500)}catch(e){return ''}}

/* ── main ──────────────────────────────────────────────────────────────── */
export async function main(deps){
  chromium=(deps&&deps.chromium)||(await import('playwright-core')).chromium;
  if(!BASE||!SECRET){console.error('CADENCE_URL and FREE_HARVEST_SECRET are required.');process.exit(1)}
  const c=await api('claim',{runner:RUNNER});
  if(!c.job){console.log('No research shard waiting.');return}
  JOB=c.job;SHARD=c.shard||0;BRIEF=C.normBrief(JOB.brief);
  Object.assign(G,{accepted:c.accepted||0,target:JOB.target||BRIEF.target_count,budget:Number(JOB.brief.max_cost_usd)||BRIEF.max_cost_usd,planned:!!JOB.planned});
  S=c.ckpt&&c.ckpt.v===2?c.ckpt:C.newState(BRIEF);
  if(c.ckpt&&c.ckpt.v===1){ // older single-machine checkpoint: keep what it learned, hand its unexplored hashtags to the shared queue
    Object.assign(S,{seen:c.ckpt.seen||{},cand:c.ckpt.cand||{},triageQ:c.ckpt.triageQ||[],fetchQ:c.ckpt.fetchQ||[],deepQ:c.ckpt.deepQ||[],
      escalateQ:c.ckpt.escalateQ||[],probeQ:c.ckpt.probeQ||[],dossiers:c.ckpt.dossiers||{},hashCo:c.ckpt.hashCo||{},reasons:c.ckpt.reasons||{},notes:c.ckpt.notes||[],
      tags:c.ckpt.tags||{},planned:!!c.ckpt.planned,disq:c.ckpt.disq,persona:c.ckpt.persona});
    Object.assign(S.stats,c.ckpt.stats||{});S.v=2;S.poolBuf=[];S.soundCo={};
    G.planned=S.planned;if(S.planned)JOB.planned=true}
  S.poolBuf=S.poolBuf||[];S.soundCo=S.soundCo||{};localSources=S.localSources||[];
  S.stats.elapsedMsBase=S.stats.elapsedMs||0;
  if(S.disq)BRIEF._disq=S.disq;else if(JOB.disq){BRIEF._disq=JOB.disq;S.persona=JOB.persona;S.keywords=JOB.keywords}
  const repaired=C.repairQueues(S);
  log(`Machine ${SHARD+1}/${JOB.nShards||1} on "${BRIEF.title}" — ${G.accepted} accepted so far, target ${G.target}.${repaired?` ${repaired} in-flight creators put back in line.`:''}`);
  browser=await chromium.launch({headless:true});await newContext();
  try{
    if(c.planner&&!JOB.planned&&!S.planned){await plan();await scanPool()}
    else if(c.ckpt&&c.ckpt.v===1){await pushSources(Object.entries(S.tags).filter(([,v])=>v.st==='todo').map(([t,v])=>({key:'t:'+t,pri:v.pri})))}
    // machines that aren't planning wait for the plan (its disqualifiers are part of the free gate)
    for(let i=0;i<40&&!G.planned&&!S.planned;i++){await sleep(20000);await checkpoint({shardStatus:'running'})}
    await checkpoint({shardStatus:'running'});
    await Promise.all([controlLoop(),browserLoop(0),browserLoop(1),triageLoop(),triageLoop(),fetchLoop(),fetchLoop(),fetchLoop(),fetchLoop(),vetLoop(),vetLoop()]);
  }catch(e){
    log('Session error: '+e.message.slice(0,200));
    if(e.budget){shardStatus='queued';stopWhy='Daily AI budget for research reached — continuing after the reset.'}
    else if(!shardStatus){shardStatus='queued';stopWhy='Recovering from an error — the next session continues from the checkpoint.'}
  }finally{await browser.close().catch(()=>{})}
  if(stopWhy!=='cancelled')log(stopWhy);
  // anything a failed batch left out of every queue goes back in line for the next session
  C.repairQueues(S);
  const r=await checkpoint({shardStatus:shardStatus||'queued',stopWhy:shardStatus==='done'?stopWhy:''});
  if(r.allDone&&!r.reportWritten&&stopWhy!=='cancelled'){const rep=await finalReport();if(rep)await checkpoint({report:rep,shardStatus:'done'})}
  console.log('Session finished:',shardStatus,JSON.stringify(S.stats))}

if(process.argv[1]&&import.meta.url.endsWith(process.argv[1].split('/').pop())&&!process.env.RESEARCH_NO_AUTORUN)main().catch(e=>{console.error(e);process.exit(1)});
