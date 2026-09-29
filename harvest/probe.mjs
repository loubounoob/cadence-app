// One-off feasibility probe: what does TikTok give a signed-out headless
// browser on a datacenter runner? Prints counts + samples only.
import {chromium} from 'playwright-core';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function capture(ctx,url,re,{scrolls=0,wait=4000}={}){
  const page=await ctx.newPage();const hits=[];
  page.on('response',async r=>{const u=r.url();if(!re.test(u))return;
    try{hits.push({u:u.split('?')[0],j:await r.json()})}catch(e){hits.push({u:u.split('?')[0],err:e.message})}});
  let ssr=null,title='',blocked=false;
  try{
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:40000});
    await sleep(wait);
    for(let i=0;i<scrolls;i++){await page.mouse.wheel(0,5000);await sleep(1400+Math.random()*800)}
    title=await page.title();
    ssr=await page.evaluate(()=>{const s=document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');return s?s.textContent:null});
    blocked=await page.evaluate(()=>/log in|captcha|verify/i.test(document.body.innerText.slice(0,3000)));
  }catch(e){console.log('  goto error',e.message)}
  await page.close();
  return {hits,ssr:ssr?JSON.parse(ssr):null,title,blocked}}

(async()=>{
  const browser=await chromium.launch({headless:true});
  const ctx=await browser.newContext({userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',locale:'en-US',viewport:{width:1366,height:900}});

  console.log('== 1. hashtag depth: #bodybuilding, 25 scrolls');
  const t=await capture(ctx,'https://www.tiktok.com/tag/bodybuilding',/\/api\/challenge\/item_list\//,{scrolls:25});
  const items=t.hits.flatMap(h=>(h.j&&h.j.itemList)||[]);
  const authors=new Map();items.forEach(i=>i.author&&authors.set(i.author.uniqueId,{f:(i.authorStats||{}).followerCount,sig:i.author.signature}));
  console.log(`  responses=${t.hits.length} items=${items.length} uniqueAuthors=${authors.size} blocked=${t.blocked}`);
  console.log('  sample item keys:',items[0]?Object.keys(items[0]).join(','):'none');
  console.log('  sample author keys:',items[0]?Object.keys(items[0].author||{}).join(','):'none');
  const mids=[...authors.entries()].filter(([h,a])=>a.f>=5000&&a.f<=500000).slice(0,3).map(x=>x[0]);
  console.log('  mid-size sample:',mids.join(', '));

  console.log('== 2. profile pages');
  for(const h of mids){
    const p=await capture(ctx,`https://www.tiktok.com/@${h}`,/\/api\/post\/item_list\//,{scrolls:3});
    const scope=p.ssr&&p.ssr.__DEFAULT_SCOPE__;const ud=scope&&scope['webapp.user-detail'];
    const ui=ud&&ud.userInfo;
    const posts=p.hits.flatMap(x=>(x.j&&x.j.itemList)||[]);
    console.log(`  @${h}: ssrUser=${!!ui} followers=${ui&&ui.stats&&ui.stats.followerCount} bioLink=${ui&&ui.user&&ui.user.bioLink&&ui.user.bioLink.link} sig="${ui&&ui.user&&String(ui.user.signature).slice(0,60)}" postsApi=${p.hits.length}/${posts.length} blocked=${p.blocked}`);
    if(ui)console.log('   user keys:',Object.keys(ui.user||{}).join(','));
    if(posts[0])console.log('   post sample:',JSON.stringify({desc:posts[0].desc,stats:posts[0].stats,createTime:posts[0].createTime}).slice(0,300));
    await sleep(2500);
  }

  console.log('== 3. user search');
  const us=await capture(ctx,'https://www.tiktok.com/search/user?q=bodybuilding%20coach',/\/api\/search\//,{scrolls:4});
  const users=us.hits.flatMap(h=>(h.j&&h.j.user_list)||[]);
  console.log(`  responses=${us.hits.length} users=${users.length} blocked=${us.blocked} urls=${[...new Set(us.hits.map(h=>h.u))].join(' ')}`);
  if(us.hits[0]&&us.hits[0].j)console.log('  keys:',Object.keys(us.hits[0].j).join(','),'status',us.hits[0].j.status_code,us.hits[0].j.status_msg||'');

  console.log('== 4. video search');
  const vs=await capture(ctx,'https://www.tiktok.com/search/video?q=natural%20bodybuilding',/\/api\/search\//,{scrolls:4});
  const vids=vs.hits.flatMap(h=>((h.j&&(h.j.item_list||h.j.data))||[]));
  console.log(`  responses=${vs.hits.length} rows=${vids.length} blocked=${vs.blocked}`);
  if(vs.hits[0]&&vs.hits[0].j)console.log('  keys:',Object.keys(vs.hits[0].j).join(','),'status',vs.hits[0].j.status_code);

  console.log('== 5. plain fetch of a profile (no browser)');
  if(mids[0]){const r=await fetch(`https://www.tiktok.com/@${mids[0]}`,{headers:{'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36','accept-language':'en-US'}});
    const html=await r.text();const m=html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
    let ok=false;try{const d=JSON.parse(m[1]);ok=!!d.__DEFAULT_SCOPE__['webapp.user-detail'].userInfo.user}catch(e){}
    console.log(`  status=${r.status} len=${html.length} ssrUser=${ok}`)}

  console.log('== 6. bio link fetch');
  const link='https://linktr.ee/linktree';
  try{const r=await fetch(link,{headers:{'user-agent':'Mozilla/5.0'}});const html=await r.text();
    console.log(`  ${link} status=${r.status} len=${html.length} emails=${(html.match(/[\w.+-]+@[\w-]+\.[\w.]+/g)||[]).slice(0,3).join(',')}`)}catch(e){console.log('  err',e.message)}
  await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
