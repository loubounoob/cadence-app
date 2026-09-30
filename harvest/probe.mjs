// Probe #5: TikTok keyword (SEO) video lists from a datacenter runner — plain HTTP vs in-browser.
import {chromium} from 'playwright-core';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const KW=[['programme-musculation','FR'],['musculation-femme','FR'],['coach-musculation','FR'],['muskelaufbau','DE'],['krafttraining','DE'],['gym-motivation','US']];
const vl=(kw,reg,off)=>`https://www.tiktok.com/api/seo/kap/video_list/?appId=1233&count=16&keyword=${kw}&pageType=7&region=${reg}&trafficType=0&offset=${off}`;
(async()=>{
  console.log('== plain HTTP');
  let total=0;const authors=new Set();
  for(const [kw,reg] of KW){let n=0,pages=0;
    for(let off=0;off<200;off+=16){
      const r=await fetch(vl(kw,reg,off),{headers:{'user-agent':UA,'accept-language':'fr-FR,fr;q=0.9',referer:`https://www.tiktok.com/discover/${kw}`}});
      const t=await r.text();let j={};try{j=JSON.parse(t)}catch(e){}
      const l=j.videoList||[];n+=l.length;pages++;l.forEach(x=>authors.add(x.author&&x.author.uniqueId));
      if(!l.length||!j.hasMore){if(off===0)console.log(`   ${kw}: status=${r.status} len=${t.length} code=${j.status_code} ${t.slice(0,120)}`);break}
      await sleep(400)}
    total+=n;console.log(`  ${kw}/${reg}: ${n} videos over ${pages} pages`)}
  console.log(`  plain total=${total} uniqueAuthors=${authors.size}`);
  const rk=await (await fetch(`https://www.tiktok.com/api/seo/kap/related_keywords/?appId=1233&count=60&keyword=programme-musculation&region=FR&trafficType=0`,{headers:{'user-agent':UA}})).text();
  console.log('  related:',rk.slice(0,300));

  console.log('== in-browser fetch (page context)');
  const browser=await chromium.launch({headless:true});
  const ctx=await browser.newContext({userAgent:UA,locale:'fr-FR'});
  const page=await ctx.newPage();
  await page.goto('https://www.tiktok.com/discover/programme-musculation',{waitUntil:'domcontentloaded',timeout:40000});await sleep(4000);
  for(const [kw,reg] of KW.slice(0,3)){
    const r=await page.evaluate(async u=>{const x=await fetch(u);const j=await x.json().catch(()=>({}));return {s:x.status,n:(j.videoList||[]).length,more:j.hasMore}},vl(kw,reg,0));
    console.log(`  ${kw}: ${JSON.stringify(r)}`)}
  await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
