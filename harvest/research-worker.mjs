#!/usr/bin/env node
/* Deep creator research worker — runs on GitHub Actions (free minutes on a
   public repo, up to ~6 h per session), resumes itself across sessions from
   a checkpoint in the app's Redis. All logic lives in research-core.mjs;
   this file only does IO and scheduling.

   Sources, all public and signed-out (verified from an Actions runner):
   - hashtag feed  www.tiktok.com/tag/{tag}      headless Chromium, ~60 posts
   - profile       www.tiktok.com/@{h}           plain HTTP, SSR JSON
   - creator embed www.tiktok.com/embed/@{h}     plain HTTP, 10 latest + pinned
   - video page    www.tiktok.com/@{h}/video/{id} plain HTTP, likes/comments/shares
   - bio link      whatever the creator links    plain HTTP, emails + socials

   Env: CADENCE_URL, FREE_HARVEST_SECRET (sent as a header, never in a URL),
        RESEARCH_RUN_MS (session budget, default 5h15). */
import {chromium} from 'playwright-core';
import * as C from './research-core.mjs';

const BASE=(process.env.CADENCE_URL||'').replace(/\/$/,'');
const SECRET=process.env.FREE_HARVEST_SECRET||'';
const RUN_MS=Number(process.env.RESEARCH_RUN_MS)||(5*3600+15*60)*1000;
const RUNNER=(process.env.GITHUB_RUN_ID||'local')+'-'+(process.env.GITHUB_RUN_ATTEMPT||'1');
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const T0=Date.now();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const jitter=ms=>ms+Math.floor(Math.random()*ms*0.5);
const timeLeft=()=>RUN_MS-(Date.now()-T0);

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

let S=null,BRIEF=null,JOB=null;
const logBuf=[];
function log(m){console.log(m);logBuf.push(m)}

async function ai(tier,system,prompt,maxTokens){
  const payload={tier,max_tokens:maxTokens,system:[{type:'text',text:system,cache_control:{type:'ephemeral'}}],
    messages:[{role:'user',content:prompt+'\n\nReturn only one JSON object.'}]};
  const j=await api('ai',{payload},4);
  C.meter(S,tier,j.usage);
  const text=(j.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
  return C.parseJSON(text)}

/* ── polite plain-HTTP reads of public TikTok pages ───────────────────── */
let lastHit=0,httpInflight=0,httpFails=0;
async function getText(url,{timeout=20000,tiktok=true}={}){
  while(httpInflight>=3)await sleep(150);
  httpInflight++;
  try{
    if(tiktok){const gap=450-(Date.now()-lastHit);if(gap>0)await sleep(gap);lastHit=Date.now()}
    const ac=new AbortController();const to=setTimeout(()=>ac.abort(),timeout);
    const lang=(BRIEF&&BRIEF.languages[0])||'en';
    const r=await fetch(url,{signal:ac.signal,redirect:'follow',headers:{'user-agent':UA,'accept-language':`${lang},en;q=0.8`,accept:'text/html,application/xhtml+xml'}});
    const t=await r.text();clearTimeout(to);
    return {status:r.status,text:t}}
  catch(e){return {status:0,text:'',err:e.message}}
  finally{httpInflight--}}

const cache=new Map(); // handle → {prof,emb} fetched this session (not checkpointed)
async function readCreator(h){
  if(cache.has(h))return cache.get(h);
  const [p,e]=await Promise.all([getText(`https://www.tiktok.com/@${h}`),getText(`https://www.tiktok.com/embed/@${h}`)]);
  const out={prof:C.parseProfileHtml(p.text),emb:C.parseEmbedHtml(e.text,h)};
  if(!out.prof&&!out.emb)httpFails++;else httpFails=0;
  cache.set(h,out);if(cache.size>400)cache.delete(cache.keys().next().value);
  return out}

/* ── headless feed reads ─────────────────────────────────────────────── */
let browser=null,ctx=null,emptyStreak=0,resets=0;
async function newContext(){
  if(ctx)await ctx.close().catch(()=>{});
  const lang=(BRIEF.languages[0]||'en');
  ctx=await browser.newContext({userAgent:UA,locale:lang==='en'?'en-US':`${lang}-${(BRIEF.markets[0]||lang).toUpperCase()}`,viewport:{width:1366,height:900}})}
async function harvestTag(tag){
  const page=await ctx.newPage();const items=[];const seen=new Set();
  page.on('response',async r=>{if(!/\/api\/challenge\/item_list\//.test(r.url()))return;
    try{const j=await r.json();for(const it of j.itemList||[]){if(it&&it.id&&!seen.has(it.id)){seen.add(it.id);items.push(it)}}}catch(e){}});
  try{
    await page.goto(`https://www.tiktok.com/tag/${encodeURIComponent(tag)}`,{waitUntil:'domcontentloaded',timeout:40000});
    await sleep(jitter(3500));
    for(let i=0;i<3;i++){
      for(const sel of ['[data-e2e="modal-close-inner-button"]','[data-e2e="modal-close-button"]']){try{const el=await page.$(sel);if(el)await el.click({timeout:800})}catch(e){}}
      await page.mouse.wheel(0,4500);await sleep(jitter(1600))}
  }catch(e){log(`  ! #${tag}: ${e.message.slice(0,100)}`)}
  finally{await page.close().catch(()=>{})}
  return items}

/* ── stages ──────────────────────────────────────────────────────────── */
let stop=false,finalStatus='',finalWhy='';
let supervising=false,aiBusy=0;
const pendingResults=[];

async function plan(){
  log('Planning the search with Sonnet…');
  const out=await ai('sonnet',C.PLAN_SYS,C.planPrompt(BRIEF),4000);
  const n=C.applyPlan(S,BRIEF,out);
  BRIEF.example_creators.forEach(h=>{if(!S.seen[h]){S.seen[h]='m';S.probeQ.push(h)}});
  log(`Plan ready — ${n} hashtags to explore${BRIEF.example_creators.length?`, plus ${BRIEF.example_creators.length} reference creators`:''}. ${S.persona?'Target: '+S.persona:''}`)}

async function supervise(force){
  if(supervising)return 0;supervising=true;
  try{const out=await ai('sonnet',C.SUP_SYS,C.supervisorPrompt(S,BRIEF,JOB.target),3000);
    const r=C.applySupervisor(S,out);
    log(`Supervisor: ${r.note||'adjusted the search'} (+${r.added} hashtags${r.dropped?`, −${r.dropped}`:''})`);
    return r.added}
  catch(e){log('Supervisor step failed: '+e.message.slice(0,120));return 0}
  finally{supervising=false}}

async function browserLoop(){
  while(!stop){
    if(S.triageQ.length>600||S.fetchQ.length>400||S.deepQ.length>150){await sleep(3000);continue}
    const tag=C.nextTag(S);
    if(!tag){await sleep(4000);continue}
    const items=await harvestTag(tag);
    if(!items.length){
      const T=S.tags[tag];T.fails=(T.fails||0)+1;T.pri-=25;if(T.fails>=2)T.st='empty';
      emptyStreak++;
      if(emptyStreak>=6){resets++;emptyStreak=0;log(`TikTok returned nothing for several hashtags in a row — fresh browser session (${resets}).`);
        await newContext();await sleep(resets>3?120000:30000)}
      continue}
    emptyStreak=0;
    const fresh=C.ingestFeed(S,BRIEF,tag,items);
    log(`#${tag}: ${items.length} posts, ${fresh} new creators`);
    if(S.tagsSinceSupervise>=C.LIMITS.SUPERVISE_EVERY_TAGS)supervise();
    await sleep(jitter(2200))}}

async function triageLoop(){
  while(!stop){
    const ready=S.triageQ.length>=C.LIMITS.TRIAGE_BATCH||(S.triageQ.length&&!C.nextTag(S));
    if(!ready){await sleep(2500);continue}
    const batch=S.triageQ.splice(0,C.LIMITS.TRIAGE_BATCH).filter(h=>S.cand[h]);
    if(!batch.length)continue;
    aiBusy++;
    try{const out=await ai('haiku',C.TRIAGE_SYS,C.triagePrompt(BRIEF,batch,S),Math.min(4000,batch.length*60+200));
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
    cap:vids.slice(-4).map(v=>v.desc),views:vids.map(v=>v.views),lang:prof&&prof.lang?[prof.lang]:[],via:['@mention']};
  S.cand[h]=c;S.stats.authorsSeen++;
  const why=C.gate(BRIEF,c);
  if(why){S.seen[h]='g';S.stats.gated++;delete S.cand[h]}else{S.seen[h]='q';S.triageQ.push(h)}}

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
  const why=C.dossierGate(BRIEF,d);
  if(why){S.seen[h]='r';S.stats.rejected++;S.reasons['dossier: '+why]=(S.reasons['dossier: '+why]||0)+1;delete S.cand[h];return}
  S.dossiers[h]=d;S.deepQ.push(h);delete S.cand[h]}

async function fetchLoop(){
  while(!stop){
    if(S.deepQ.length>80){await sleep(2000);continue}
    if(httpFails>=12){log('Profile pages are not answering — pausing reads for 2 minutes.');httpFails=0;await sleep(120000);continue}
    let h=S.probeQ.shift();
    if(h){try{await probeOne(h)}catch(e){S.seen[h]='e'}continue}
    h=S.fetchQ.shift();
    if(h&&S.cand[h]){try{await dossierOne(h)}catch(e){log(`  ! dossier @${h}: ${e.message.slice(0,80)}`);S.seen[h]='e';delete S.cand[h]}continue}
    await sleep(1500)}}

async function finalize(d,v,tier){
  delete S.dossiers[d.handle];
  if(!v.accept){S.seen[d.handle]='r';S.stats.rejected++;const k='vetting: '+(v.flags[0]||v.verdict);S.reasons[k]=(S.reasons[k]||0)+1;return}
  let page='';
  if(d.bioLink&&/^https?:\/\//.test(d.bioLink)&&!/tiktok\.com/.test(d.bioLink)){const r=await getText(d.bioLink,{timeout:12000,tiktok:false});page=r.text.slice(0,400000)}
  const contacts=C.contactsFrom(d,page);
  if(BRIEF.contact_required&&!contacts.email&&!contacts.instagram){S.seen[d.handle]='r';S.stats.rejected++;S.reasons['no contact']=(S.reasons['no contact']||0)+1;return}
  S.seen[d.handle]='a';S.stats.accepted++;
  C.learnFromAccepted(S,d);
  pendingResults.push(C.resultRecord(d,v,contacts,tier));
  log(`✓ @${d.handle} — ${v.score}/100 · ${v.niche}${contacts.email?' · email found':''}`)}

async function vetBatch(tier,handles){
  const ds=handles.map(h=>S.dossiers[h]).filter(Boolean);
  if(!ds.length)return;
  aiBusy++;
  try{
    const out=await ai(tier,C.VET_SYS,C.vetPrompt(BRIEF,ds),Math.min(4000,ds.length*420+200));
    const by={};(out.results||[]).forEach(r=>{if(r&&r.h)by[C.cleanHandle(r.h)]=r});
    for(const d of ds){
      const r=by[d.handle];
      if(!r){(tier==='sonnet'&&BRIEF.quality==='balanced'?S.escalateQ:S.deepQ).push(d.handle);continue}
      S.stats.vetted++;
      const v=C.readVerdict(r,BRIEF);
      if(C.needsEscalation(v,BRIEF,tier)){S.escalateQ.push(d.handle);S.stats.escalated++;continue}
      await finalize(d,v,tier)}}
  catch(e){(tier==='sonnet'&&BRIEF.quality==='balanced'?S.escalateQ:S.deepQ).unshift(...ds.map(d=>d.handle));
    log(`Vetting batch failed, will retry: ${e.message.slice(0,100)}`);await sleep(10000)}
  finally{aiBusy--}}

async function vetLoop(){
  while(!stop){
    const upstreamIdle=!C.nextTag(S)&&!S.triageQ.length&&!S.fetchQ.length&&!S.probeQ.length;
    if(BRIEF.quality==='balanced'&&(S.escalateQ.length>=C.LIMITS.DEEP_BATCH_SONNET||(S.escalateQ.length&&upstreamIdle&&!S.deepQ.length))){
      await vetBatch('sonnet',S.escalateQ.splice(0,C.LIMITS.DEEP_BATCH_SONNET));continue}
    const tier=BRIEF.quality==='max'?'sonnet':'haiku';
    const n=tier==='sonnet'?C.LIMITS.DEEP_BATCH_SONNET:C.LIMITS.DEEP_BATCH_HAIKU;
    if(S.deepQ.length>=n||(S.deepQ.length&&upstreamIdle)){await vetBatch(tier,S.deepQ.splice(0,n));continue}
    await sleep(2500)}}

/* ── checkpointing + control ─────────────────────────────────────────── */
function phaseName(){
  if(!S.planned)return 'planning';
  if(S.stats.accepted>=JOB.target)return 'finishing';
  return 'searching'}
function progressPatch(extra){
  S.stats.elapsedMs=(S.stats.elapsedMsBase||0)+(Date.now()-T0);
  const tagList=Object.entries(S.tags);
  return {stats:{...S.stats,tagsQueued:tagList.filter(([,v])=>v.st==='todo').length,tagsTotal:tagList.length,
      queue:{triage:S.triageQ.length,dossier:S.fetchQ.length+S.probeQ.length,vetting:S.deepQ.length+S.escalateQ.length}},
    phase:phaseName(),
    strategy:{persona:S.persona||'',notes:S.notes.slice(-6),
      bestTags:tagList.filter(([,v])=>v.acc).sort((a,b)=>b[1].acc-a[1].acc).slice(0,15).map(([t,v])=>({t,acc:v.acc,authors:v.authors})),
      reasons:Object.entries(S.reasons).sort((a,b)=>b[1]-a[1]).slice(0,10)},
    ...(extra||{})}}
async function flushResults(){
  while(pendingResults.length){const part=pendingResults.splice(0,60);
    try{await api('add',{id:JOB.id,creators:part})}catch(e){pendingResults.unshift(...part);log('Could not store results yet: '+e.message.slice(0,80));return}}}
async function checkpoint(extra){
  await flushResults();
  const r=await api('save',{id:JOB.id,patch:progressPatch(extra),ckpt:S,log:logBuf.splice(0,logBuf.length)});
  return r.status}

async function controlLoop(){
  let lastSave=Date.now(),dryChecks=0;
  while(!stop){
    await sleep(5000);
    if(S.stats.accepted>=JOB.target){finalStatus='done';finalWhy=`Target reached — ${S.stats.accepted} creators vetted and accepted.`;stop=true;break}
    if(S.stats.costUsd>=BRIEF.max_cost_usd){finalStatus='done';finalWhy=`AI budget for this search reached ($${S.stats.costUsd.toFixed(2)}). Resume with a higher budget to keep going.`;stop=true;break}
    if(timeLeft()<4*60000){finalStatus='queued';finalWhy='Session time used — the next session continues from here automatically.';stop=true;break}
    if(C.isExhausted(S)&&!aiBusy&&!supervising){
      dryChecks++;
      if(dryChecks>=2){
        const added=S.expansionsDry<3?await supervise(true):0;
        if(!added){S.expansionsDry++;if(S.expansionsDry>=3){finalStatus='done';finalWhy=`Search exhausted — every promising hashtag and lead in this niche has been explored (${S.stats.accepted} creators accepted).`;stop=true;break}}
        else S.expansionsDry=0;
        dryChecks=0}}
    else dryChecks=0;
    if(Date.now()-lastSave>60000){lastSave=Date.now();
      try{const st=await checkpoint({status:'running'});if(st==='cancel_requested'){finalStatus='cancelled';finalWhy='Stopped at your request.';stop=true}}
      catch(e){console.log('checkpoint failed: '+e.message)}}}}

async function finalReport(){
  try{
    const acc=Object.entries(S.tags).filter(([,v])=>v.acc).sort((a,b)=>b[1].acc-a[1].acc).slice(0,12).map(([t,v])=>`#${t}(${v.acc})`).join(' ');
    const out=await ai('sonnet','You write short, concrete research reports for brand marketers. Answer only with the JSON asked for.',
      `BRIEF\n${C.briefText(BRIEF)}\n\nOUTCOME: ${S.stats.accepted} creators accepted after ${S.stats.authorsSeen} seen, ${S.stats.triaged} triaged, ${S.stats.vetted} fully vetted. Most productive hashtags: ${acc}. Main rejection reasons: ${Object.entries(S.reasons).sort((a,b)=>b[1]-a[1]).slice(0,6).map(([r,n])=>r+' '+n).join('; ')}. Supervisor notes: ${S.notes.slice(-4).join(' | ')}.
Write {"report":"4-6 sentences in language '${BRIEF.summary_language}': what was found, where the best creators came from, what to know before outreach"}`,900);
    return String(out.report||'').slice(0,1500)}catch(e){return ''}}

/* ── main ────────────────────────────────────────────────────────────── */
async function main(){
  if(!BASE||!SECRET){console.error('CADENCE_URL and FREE_HARVEST_SECRET are required.');process.exit(1)}
  const c=await api('claim',{runner:RUNNER});
  if(!c.job){console.log('No research job waiting.');return}
  JOB=c.job;BRIEF=C.normBrief(JOB.brief);JOB.target=JOB.target||BRIEF.target_count;
  S=c.ckpt&&c.ckpt.v===1?c.ckpt:C.newState(BRIEF);
  S.stats.elapsedMsBase=S.stats.elapsedMs||0;
  if(S.disq)BRIEF._disq=S.disq;
  const repaired=C.repairQueues(S);if(repaired)log(`Put ${repaired} in-flight creators back in line from the last session.`);
  log(`Session ${JOB.runs||1} on "${BRIEF.title}" — ${S.stats.accepted} accepted so far, target ${JOB.target}.`);
  // anything that was mid-flight when the last session ended goes back in line
  browser=await chromium.launch({headless:true});await newContext();
  try{
    if(!S.planned)await plan();
    await checkpoint({status:'running'});
    await Promise.all([controlLoop(),browserLoop(),triageLoop(),triageLoop(),fetchLoop(),fetchLoop(),fetchLoop(),vetLoop(),vetLoop()]);
  }catch(e){
    log('Session error: '+e.message.slice(0,200));
    if(e.budget){finalStatus='queued';finalWhy='Daily AI budget for research reached — continuing after the reset.'}
    else if(!finalStatus){finalStatus='queued';finalWhy='Recovering from an error — the next session continues from the checkpoint.'}
  }finally{await browser.close().catch(()=>{})}
  log(finalWhy);
  const extra={status:finalStatus||'queued'};
  if(finalStatus==='done'||finalStatus==='cancelled'){extra.finishedAt=new Date().toISOString();extra.report=await finalReport()}
  await checkpoint(extra);
  console.log('Session finished:',finalStatus,JSON.stringify(S.stats))}

main().catch(e=>{console.error(e);process.exit(1)});
