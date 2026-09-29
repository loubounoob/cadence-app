// Feasibility probe #2: how deep can a signed-out headless browser go?
import {chromium} from 'playwright-core';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

async function closeModals(page){
  for(const sel of ['[data-e2e="modal-close-inner-button"]','[data-e2e="modal-close-button"]','div[role="dialog"] button[aria-label*="lose"]']){
    try{const el=await page.$(sel);if(el){await el.click({timeout:1000});return true}}catch(e){}}
  try{await page.keyboard.press('Escape')}catch(e){}
  return false}

(async()=>{
  const browser=await chromium.launch({headless:true});
  const ctx=await browser.newContext({userAgent:UA,locale:'en-US',viewport:{width:1366,height:900}});

  console.log('== A. tag page with modal closing + in-page cursor replay');
  {const page=await ctx.newPage();const reqs=[];let n=0;
    page.on('response',async r=>{if(/\/api\/challenge\/item_list\//.test(r.url())){reqs.push(r.url());try{const j=await r.json();n+=(j.itemList||[]).length;console.log('   resp items',(j.itemList||[]).length,'hasMore',j.hasMore,'cursor',j.cursor)}catch(e){}}});
    await page.goto('https://www.tiktok.com/tag/bodybuilding',{waitUntil:'domcontentloaded',timeout:40000});await sleep(5000);
    const ssr=await page.evaluate(()=>{const s=document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');return s?s.textContent:null});
    try{const d=JSON.parse(ssr);const sc=d.__DEFAULT_SCOPE__;console.log('  tag ssr scope keys:',Object.keys(sc).join(','));
      const cd=sc['webapp.challenge-detail'];if(cd)console.log('  challengeInfo:',JSON.stringify(cd.challengeInfo&&cd.challengeInfo.stats||cd).slice(0,300))}catch(e){console.log('  no ssr')}
    for(let i=0;i<12;i++){const c=await closeModals(page);await page.mouse.wheel(0,5000);await sleep(1800);if(c)console.log('   closed modal at scroll',i)}
    console.log(`  after scrolling: requests=${reqs.length} items=${n}`);
    if(reqs[0]){
      const base=reqs[reqs.length-1];
      for(const cur of [60,90,120,300]){
        const u=base.replace(/([?&])cursor=\d+/,`$1cursor=${cur}`);
        const r=await page.evaluate(async u=>{try{const x=await fetch(u,{credentials:'include'});const t=await x.text();let j={};try{j=JSON.parse(t)}catch(e){};return {s:x.status,len:t.length,items:(j.itemList||[]).length,hasMore:j.hasMore,code:j.statusCode}}catch(e){return {err:e.message}}},u);
        console.log(`   replay cursor=${cur}:`,JSON.stringify(r))}
      // signing check: strip X-Bogus params and call from page
      const stripped=base.replace(/&X-Bogus=[^&]*/,'').replace(/&X-Gnarly=[^&]*/,'').replace(/([?&])cursor=\d+/,'$1cursor=150');
      const r2=await page.evaluate(async u=>{try{const x=await fetch(u);const t=await x.text();let j={};try{j=JSON.parse(t)}catch(e){};return {s:x.status,len:t.length,items:(j.itemList||[]).length}}catch(e){return {err:e.message}}},stripped);
      console.log('   unsigned replay cursor=150:',JSON.stringify(r2));
      console.log('   sample request url:',base.slice(0,400))}
    await page.close()}

  console.log('== B. profile posts');
  const handles=['ashenb_real','muscleworldx'];
  for(const h of handles){
    const page=await ctx.newPage();const got=[];
    page.on('response',async r=>{if(/\/api\/post\/item_list\//.test(r.url())){try{const j=await r.json();got.push({u:r.url(),items:(j.itemList||[]).length,code:j.statusCode,keys:Object.keys(j).join(',')})}catch(e){got.push({u:r.url(),err:e.message})}}});
    await page.goto(`https://www.tiktok.com/@${h}`,{waitUntil:'domcontentloaded',timeout:40000});await sleep(5000);
    for(let i=0;i<4;i++){await closeModals(page);await page.mouse.wheel(0,4000);await sleep(1800)}
    const domVideos=await page.evaluate(()=>[...document.querySelectorAll('a[href*="/video/"]')].map(a=>a.href).slice(0,40));
    const views=await page.evaluate(()=>[...document.querySelectorAll('[data-e2e="video-views"]')].map(e=>e.textContent).slice(0,40));
    const ssr=await page.evaluate(()=>{const s=document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');return s?s.textContent:null});
    let scopeKeys='';try{scopeKeys=Object.keys(JSON.parse(ssr).__DEFAULT_SCOPE__).join(',')}catch(e){}
    console.log(`  @${h}: api=${JSON.stringify(got).slice(0,500)}`);
    console.log(`   dom video links=${domVideos.length} views=${views.slice(0,10).join('|')} scope=${scopeKeys}`);
    if(got[0]&&got[0].u){
      const u=got[0].u;
      const r=await page.evaluate(async u=>{try{const x=await fetch(u,{credentials:'include'});const t=await x.text();let j={};try{j=JSON.parse(t)}catch(e){};return {s:x.status,len:t.length,items:(j.itemList||[]).length,code:j.statusCode}}catch(e){return {err:e.message}}},u);
      console.log('   in-page replay:',JSON.stringify(r))}
    // single video page: captions + stats in SSR?
    if(domVideos[0]){
      const vp=await ctx.newPage();await vp.goto(domVideos[0],{waitUntil:'domcontentloaded',timeout:40000});await sleep(3000);
      const v=await vp.evaluate(()=>{const s=document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');try{const d=JSON.parse(s.textContent).__DEFAULT_SCOPE__;const it=d['webapp.video-detail'].itemInfo.itemStruct;return {desc:it.desc,stats:it.stats,ct:it.createTime}}catch(e){return {err:e.message}}});
      console.log('   video page ssr:',JSON.stringify(v).slice(0,300));await vp.close()}
    await page.close();await sleep(2000)}

  console.log('== C. plain-fetch video page + profile (no browser), 5 in a row');
  for(const h of ['ashenb_real','muscleworldx','mike.israetel.clips','natty_or_not_','jeffnippard']){
    const t0=Date.now();
    const r=await fetch(`https://www.tiktok.com/@${h}`,{headers:{'user-agent':UA,'accept-language':'en-US'}});
    const html=await r.text();const m=html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
    let info='';try{const d=JSON.parse(m[1]).__DEFAULT_SCOPE__['webapp.user-detail'].userInfo;info=`followers=${d.stats.followerCount} videos=${d.stats.videoCount} hearts=${d.stats.heartCount} lang=${d.user.language} region=${d.user.region||''} commerce=${JSON.stringify(d.user.commerceUserInfo||{}).slice(0,80)} itemList=${(d.itemList||[]).length}`}catch(e){info='parse fail '+e.message}
    console.log(`  @${h} ${r.status} ${Date.now()-t0}ms ${info}`)}
  await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
