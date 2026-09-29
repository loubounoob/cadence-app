#!/usr/bin/env node
/* Étage 1 — free collection: real TikTok hashtag/sound pages, read the way
   a signed-out visitor's browser already reads them, no paid actor involved.

   Verified live (see harvest/README.md for how): opening
   https://www.tiktok.com/tag/{hashtag} as a normal signed-out visitor fires
   GET https://www.tiktok.com/api/challenge/item_list/?...&challengeID=...
   which returns real recent posts for that hashtag — author handle,
   follower count, bio, verified flag, per-video stats — the exact "UGC
   tagged with this hashtag" content Creative Center's own trend pages point
   at, at $0 provider cost. The catch: TikTok signs that request client-side
   (X-Bogus / X-Gnarly / msToken), so it only works from a real rendered
   page — hence Playwright here, not a bare fetch. That is also exactly why
   this runs as a script (on GitHub Actions' free minutes) rather than
   inside a Vercel serverless function: a real Chromium is too heavy for
   that, but is free and unremarkable as a scheduled CI job.

   Flow: for each hashtag (and, once curated, each sound — see
   harvest/tags.json), open its TikTok page, capture every item_list
   response that fires as the page loads and lightly scrolls, then POST the
   raw items to /api/free-intake, which adapts and queues them for the
   running app to pull for $0 the next time it works that hashtag.

   Run:  CADENCE_URL=https://cadence-app-amber.vercel.app FREE_HARVEST_SECRET=... node harvest/free-harvest.mjs
   Needs: npm i -D playwright-core && npx playwright install chromium
   (kept out of the app's own package.json — this only ever runs in CI or by hand, never on Vercel). */
import {chromium} from 'playwright-core';
import {readFileSync} from 'fs';
import {fileURLToPath} from 'url';
import path from 'path';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const CADENCE_URL=(process.env.CADENCE_URL||'').replace(/\/$/,'');
const SECRET=process.env.FREE_HARVEST_SECRET||'';
const MAX_TAGS_PER_RUN=Number(process.env.FREE_HARVEST_MAX_TAGS||15);
const MAX_ITEMS_PER_TAG=Number(process.env.FREE_HARVEST_MAX_ITEMS||300);
const SCROLLS=Number(process.env.FREE_HARVEST_SCROLLS||6);

function loadTags(){
  const p=process.env.FREE_HARVEST_TAGS_FILE||path.join(HERE,'tags.json');
  try{
    const cfg=JSON.parse(readFileSync(p,'utf8'));
    return {hashtags:Array.isArray(cfg.hashtags)?cfg.hashtags:[],sounds:Array.isArray(cfg.sounds)?cfg.sounds:[]};
  }catch(e){console.error(`Could not read ${p}: ${e.message}. Add hashtags there (see harvest/tags.json.example).`);return {hashtags:[],sounds:[]}}}

/* Whatever real searches asked for and found nothing pre-harvested (see
   discovery.js's free-tier loop → /api/free-request) since the last run —
   this is what turns the free tier from a fixed curated list into one that
   widens itself to match actual demand. Best-effort: if the app is down or
   this fails, the run just falls back to the static tags.json list. */
async function loadRequestedTags(){
  if(!CADENCE_URL||!SECRET)return [];
  try{
    const r=await fetch(`${CADENCE_URL}/api/free-tags?secret=${encodeURIComponent(SECRET)}`);
    if(!r.ok)return [];
    const j=await r.json();
    return Array.isArray(j.tags)?j.tags:[];
  }catch(e){return []}}

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const jitter=(base)=>base+Math.floor(Math.random()*base*0.4);

/* Opens one hashtag or sound page, harvests item_list responses, returns
   the raw TikTok items collected (never adapted here — /api/free-intake
   owns that, so the two ends of this pipe agree on the shape in exactly
   one place). */
async function harvestPage(context,url,{maxItems,scrolls}){
  const page=await context.newPage();
  const items=[];
  const seen=new Set();
  page.on('response',async resp=>{
    if(items.length>=maxItems)return;
    const u=resp.url();
    if(!/\/api\/(challenge|music)\/item_list\//.test(u))return;
    try{
      const j=await resp.json();
      for(const it of (j&&j.itemList)||[]){
        const id=it&&it.id;if(id&&seen.has(id))continue;if(id)seen.add(id);
        items.push(it);if(items.length>=maxItems)break}
    }catch(e){/* not JSON, or body already consumed — ignore, next response may still land */}
  });
  try{
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000});
    for(let i=0;i<scrolls&&items.length<maxItems;i++){
      await page.mouse.wheel(0,4000);
      await sleep(jitter(1500));
    }
  }catch(e){console.error(`  ! ${url}: ${e.message}`)}
  finally{await page.close().catch(()=>{})}
  return items}

async function intake(tag,items){
  if(!items.length)return {ok:true,added:0};
  const r=await fetch(`${CADENCE_URL}/api/free-intake`,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({secret:SECRET,tag,items})});
  let j={};try{j=await r.json()}catch(e){}
  if(!r.ok)throw new Error(`free-intake ${r.status}: ${JSON.stringify(j).slice(0,200)}`);
  return j}

async function main(){
  if(!CADENCE_URL||!SECRET){console.error('CADENCE_URL and FREE_HARVEST_SECRET are required.');process.exit(1)}
  const {hashtags:staticTags,sounds}=loadTags();
  const requested=await loadRequestedTags();
  if(requested.length)console.log(`${requested.length} on-demand tag(s) requested by live searches: ${requested.join(', ')}`);
  // on-demand requests go first — they're what a real search is waiting on
  // right now, the static list just fills the rest of this run's budget.
  const hashtags=[...new Set([...requested,...staticTags])];
  if(!hashtags.length&&!sounds.length){console.error('No hashtags or sounds configured — nothing to do.');return}
  const browser=await chromium.launch({headless:true});
  const context=await browser.newContext({
    userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    locale:'en-US',viewport:{width:1280,height:900}});
  let totalAdded=0,tagsRun=0;
  try{
    for(const tag of hashtags.slice(0,MAX_TAGS_PER_RUN)){
      const clean=String(tag).toLowerCase().replace(/^#/,'').trim();if(!clean)continue;
      console.log(`hashtag #${clean} …`);
      const items=await harvestPage(context,`https://www.tiktok.com/tag/${encodeURIComponent(clean)}`,
        {maxItems:MAX_ITEMS_PER_TAG,scrolls:SCROLLS});
      console.log(`  ${items.length} post(s) captured`);
      try{const j=await intake(clean,items);totalAdded+=j.added||0;console.log(`  queued ${j.added||0} row(s)`)}
      catch(e){console.error(`  ! intake failed: ${e.message}`)}
      tagsRun++;
      await sleep(jitter(2500)); // be a polite, boring visitor between pages
    }
    for(const s of sounds.slice(0,Math.max(0,MAX_TAGS_PER_RUN-tagsRun))){
      if(!s||!s.id)continue;
      const key='sound_'+s.id;
      console.log(`sound "${s.name||s.id}" …`);
      const items=await harvestPage(context,`https://www.tiktok.com/music/${encodeURIComponent(s.name||'sound')}-${encodeURIComponent(s.id)}`,
        {maxItems:MAX_ITEMS_PER_TAG,scrolls:SCROLLS});
      console.log(`  ${items.length} post(s) captured`);
      try{const j=await intake(key,items);totalAdded+=j.added||0;console.log(`  queued ${j.added||0} row(s)`)}
      catch(e){console.error(`  ! intake failed: ${e.message}`)}
      await sleep(jitter(2500));
    }
  }finally{await browser.close().catch(()=>{})}
  console.log(`\nDone — ${totalAdded} row(s) queued for the app to pull, at $0 provider cost.`);
}

main().catch(e=>{console.error(e);process.exit(1)});
