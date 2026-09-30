// Probe #4: keyword (non-hashtag) sources — TikTok /discover SEO pages and web search engines.
import {chromium} from 'playwright-core';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const handlesIn=t=>{const s=String(t).replace(/%40/gi,'@').replace(/%2F/gi,'/');return [...new Set([...s.matchAll(/tiktok\.com\/@([A-Za-z0-9._]{2,30})/g)].map(m=>m[1].toLowerCase()))]};

(async()=>{
  console.log('== A. /discover keyword pages (plain HTTP)');
  for(const kw of ['musculation-femme','coach-musculation','programme-musculation','fitness-motivation-deutsch']){
    try{const r=await fetch(`https://www.tiktok.com/discover/${kw}`,{headers:{'user-agent':UA,'accept-language':'fr-FR,fr;q=0.9'}});const t=await r.text();
      const ids=[...t.matchAll(/<script[^>]*id="([^"]+)"/g)].map(m=>m[1]).join(',');
      let info='';
      const m=t.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
      if(m){try{const d=JSON.parse(m[1]).__DEFAULT_SCOPE__;const keys=Object.keys(d);info='scope='+keys.join(',');
        for(const k of keys){const s=JSON.stringify(d[k]);const au=new Set([...s.matchAll(/"uniqueId":"([^"]+)"/g)].map(x=>x[1]));if(au.size)info+=` | ${k}: ${au.size} authors, ${s.length}b`;
          const rel=s.match(/"(relatedSearches|suggestedWords|relatedKeywords|keywordList)":\[[^\]]{0,400}/);if(rel)info+=` | related: ${rel[0].slice(0,300)}`}}catch(e){info='parse '+e.message}}
      console.log(`  /discover/${kw}: ${r.status} len=${t.length} handles=${handlesIn(t).length} scripts=${ids} ${info}`)}catch(e){console.log('  err',e.message)}
    await sleep(1200)}

  console.log('== B. /discover in a browser (scroll)');
  const browser=await chromium.launch({headless:true});
  const ctx=await browser.newContext({userAgent:UA,locale:'fr-FR',viewport:{width:1366,height:900}});
  {const page=await ctx.newPage();const apis=new Map();
    page.on('response',async r=>{const u=r.url();if(!/\/api\//.test(u))return;try{const j=await r.json();const s=JSON.stringify(j);const n=new Set([...s.matchAll(/"uniqueId":"([^"]+)"/g)].map(x=>x[1])).size;if(n)apis.set(u.split('?')[0],(apis.get(u.split('?')[0])||0)+n)}catch(e){}});
    await page.goto('https://www.tiktok.com/discover/musculation-femme',{waitUntil:'domcontentloaded',timeout:40000});await sleep(5000);
    for(let i=0;i<5;i++){await page.mouse.wheel(0,5000);await sleep(2000)}
    const html=await page.content();
    const rel=await page.evaluate(()=>[...document.querySelectorAll('a[href*="/discover/"]')].map(a=>a.getAttribute('href')).slice(0,25));
    console.log(`  dom handles=${handlesIn(html).length} apis=${JSON.stringify([...apis])} relatedLinks=${rel.length} ${rel.slice(0,10).join(' ')}`);
    await page.close()}

  console.log('== C. web search engines');
  const qs=['site:tiktok.com "coach musculation"','site:tiktok.com/@ musculation "gmail.com"','site:tiktok.com fitness influencerin'];
  const eng={bing:q=>`https://www.bing.com/search?q=${encodeURIComponent(q)}&count=50`,
    ddg:q=>`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
    brave:q=>`https://search.brave.com/search?q=${encodeURIComponent(q)}`,
    mojeek:q=>`https://www.mojeek.com/search?q=${encodeURIComponent(q)}`,
    google:q=>`https://www.google.com/search?q=${encodeURIComponent(q)}&num=50`};
  for(const [k,f] of Object.entries(eng)){const res=[];
    for(const q of qs){try{const r=await fetch(f(q),{headers:{'user-agent':UA,'accept-language':'fr-FR,fr;q=0.9,en;q=0.8',accept:'text/html'}});const t=await r.text();
      res.push(`${r.status}/${handlesIn(t).length}${/captcha|unusual traffic|robot|challenge-form|cf-chl/i.test(t)?'/CAPTCHA':''}`)}catch(e){res.push('err')}
      await sleep(2000)}
    console.log(`  ${k}: ${res.join('  ')}`)}
  console.log('== D. engines in browser');
  for(const k of ['bing','brave','google']){const page=await ctx.newPage();
    try{await page.goto(eng[k](qs[0]),{waitUntil:'domcontentloaded',timeout:30000});await sleep(3500);const h=await page.content();
      console.log(`  ${k}: handles=${handlesIn(h).length} ${handlesIn(h).slice(0,8).join(',')} captcha=${/captcha|unusual traffic|robot/i.test(h)}`)}catch(e){console.log(`  ${k}: ${e.message.slice(0,80)}`)}
    await page.close()}
  await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
