// Probe #3: discovery sources beyond hashtags, from an Actions runner.
import {chromium} from 'playwright-core';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const handlesIn=t=>[...new Set([...String(t).matchAll(/tiktok\.com\/@([A-Za-z0-9._]{2,30})/g)].map(m=>m[1].toLowerCase()))];

async function cap(ctx,url,re,scrolls=4){
  const page=await ctx.newPage();const hits=[];
  page.on('response',async r=>{if(!re.test(r.url()))return;try{hits.push({u:r.url().split('?')[0],j:await r.json()})}catch(e){hits.push({u:r.url().split('?')[0],err:1})}});
  try{await page.goto(url,{waitUntil:'domcontentloaded',timeout:40000});await sleep(5000);
    for(let i=0;i<scrolls;i++){for(const s of ['[data-e2e="modal-close-inner-button"]']){try{const e=await page.$(s);if(e)await e.click({timeout:800})}catch(e){}}
      await page.mouse.wheel(0,5000);await sleep(2000)}}catch(e){console.log('  goto',e.message.slice(0,80))}
  const urls=await page.evaluate(()=>[...document.querySelectorAll('a[href*="/@"]')].map(a=>a.href)).catch(()=>[]);
  await page.close();return {hits,urls}}

(async()=>{
  const browser=await chromium.launch({headless:true});
  const ctx=await browser.newContext({userAgent:UA,locale:'fr-FR',viewport:{width:1366,height:900}});
  const items=h=>h.hits.flatMap(x=>(x.j&&(x.j.itemList||x.j.item_list))||[]);
  const authors=list=>new Set(list.map(i=>i.author&&i.author.uniqueId).filter(Boolean));

  console.log('== A. explore feed');
  const ex=await cap(ctx,'https://www.tiktok.com/explore',/\/api\/(explore|recommend|discover)/,8);
  console.log(`  apis=${[...new Set(ex.hits.map(h=>h.u))].join(' ')} items=${items(ex).length} authors=${authors(items(ex)).size} domHandles=${handlesIn(ex.urls.join(' ')).length}`);
  const ex2=await cap(ctx,'https://www.tiktok.com/explore?lang=fr&category=sports',/\/api\/(explore|recommend|discover)/,6);
  console.log(`  sports? apis=${[...new Set(ex2.hits.map(h=>h.u))].join(' ')} items=${items(ex2).length}`);
  const fy=await cap(ctx,'https://www.tiktok.com/foryou',/\/api\/recommend\/item_list/,6);
  console.log(`  foryou items=${items(fy).length}`);

  console.log('== B. sound pages');
  const tg=await cap(ctx,'https://www.tiktok.com/tag/musculation',/\/api\/challenge\/item_list/,1);
  const mus=items(tg).map(i=>i.music).filter(m=>m&&m.id&&!m.original).slice(0,1).concat(items(tg).map(i=>i.music).filter(m=>m&&m.id&&m.original).slice(0,1));
  for(const m of mus){
    const slug=String(m.title||'sound').replace(/[^A-Za-z0-9]+/g,'-').slice(0,40);
    const r=await cap(ctx,`https://www.tiktok.com/music/${slug}-${m.id}`,/\/api\/music\/item_list/,4);
    console.log(`  music "${m.title}" original=${m.original} items=${items(r).length} authors=${authors(items(r)).size} videoCount=${m.videoCount||''}`)}

  console.log('== C. video page: related feed?');
  const v=items(tg)[0];
  if(v){const r=await cap(ctx,`https://www.tiktok.com/@${v.author.uniqueId}/video/${v.id}`,/\/api\/(related|recommend)\//,3);
    console.log(`  apis=${[...new Set(r.hits.map(h=>h.u))].join(' ')} items=${items(r).length} authors=${authors(items(r)).size}`)}

  console.log('== D. search engines (plain HTTP)');
  const q='site:tiktok.com "musculation" "coach"';
  const eng={bing:`https://www.bing.com/search?q=${encodeURIComponent(q)}&count=50&setlang=fr`,
    ddg:`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
    brave:`https://search.brave.com/search?q=${encodeURIComponent(q)}`,
    google:`https://www.google.com/search?q=${encodeURIComponent(q)}&num=50`,
    startpage:`https://www.startpage.com/do/search?q=${encodeURIComponent(q)}`,
    yahoo:`https://search.yahoo.com/search?p=${encodeURIComponent(q)}&n=50`};
  for(const [k,u] of Object.entries(eng)){
    try{const r=await fetch(u,{headers:{'user-agent':UA,'accept-language':'fr-FR,fr;q=0.9,en;q=0.8',accept:'text/html'}});const t=await r.text();
      console.log(`  ${k}: ${r.status} len=${t.length} handles=${handlesIn(decodeURIComponent(t.replace(/%2F/gi,'/').replace(/%40/g,'@'))).length} captcha=${/captcha|unusual traffic|are you a robot|challenge/i.test(t)}`)}catch(e){console.log(`  ${k}: err ${e.message}`)}
    await sleep(1500)}

  console.log('== E. search engines via browser');
  for(const k of ['bing','brave','ddg']){
    const page=await ctx.newPage();
    try{await page.goto(eng[k],{waitUntil:'domcontentloaded',timeout:30000});await sleep(3000);
      const html=await page.content();console.log(`  ${k}: handles=${handlesIn(decodeURIComponent(html.replace(/%2F/gi,'/').replace(/%40/g,'@'))).length} sample=${handlesIn(html).slice(0,6).join(',')}`)}
    catch(e){console.log(`  ${k}: ${e.message.slice(0,80)}`)}
    await page.close()}

  console.log('== F. bing page 2 + bio-email query');
  for(const u of [`${eng.bing}&first=51`,`https://www.bing.com/search?q=${encodeURIComponent('site:tiktok.com "fitness" "@gmail.com"')}&count=50`]){
    try{const r=await fetch(u,{headers:{'user-agent':UA,'accept-language':'fr-FR'}});const t=await r.text();console.log(`  ${r.status} handles=${handlesIn(t).length} ${handlesIn(t).slice(0,8).join(',')}`)}catch(e){console.log('  err',e.message)}}
  await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
