// End to end: the real worker loops against the real /api/research handler
// (fake Redis + scripted model) and a synthetic TikTok. node test/test-research-worker.mjs
import {createRequire} from 'module';
const require=createRequire(import.meta.url);
const {setup,FULL}=require('./harness.js');
let pass=0,fail=0;const out=[];
const ok=(c,m)=>{if(c){pass++;out.push('  ✓ '+m)}else{fail++;out.push('  ✗ '+m)}};

process.env.CADENCE_URL='https://app.test';process.env.FREE_HARVEST_SECRET='wsec';
process.env.RESEARCH_SPEED='40';process.env.RESEARCH_NO_AUTORUN='1';process.env.RESEARCH_RUN_MS=String(4*3600e3);
const t=setup({...FULL,FREE_HARVEST_SECRET:'wsec'});
const harnessFetch=global.fetch;

/* ── a synthetic TikTok: 400 creators ─────────────────────────────────── */
const NOW=Date.now(),DAY=86400000;
const tid=(ms,i)=>((BigInt(Math.floor(ms/1000))<<32n)+BigInt(i)).toString();
const CR=[];
for(let i=0;i<400;i++){
  const kind=i%10<6?'gym':i%10<8?'dance':i%10<9?'german':'dead';
  CR.push({h:'c'+i,kind,f:[3000,20000,80000,150000,700000][i%5],
    bio:kind==='gym'?(i%3?'Coach musculation 💪 programme prise de masse · contact c'+i+'@gmail.com':'Passionnée de musculation, ma routine gym au quotidien'):
      kind==='dance'?'Danse et tendances 💃':kind==='german'?'Fitness Trainer, Muskelaufbau und Ernährung für dich':'musculation coach',
    cap:kind==='gym'?'ma séance de musculation du jour avec mon coach pour la prise de masse et on travaille les jambes dans la salle #musculation #gymtok':
      kind==='dance'?'nouvelle danse avec les copines on essaie la tendance du moment #dance':
      kind==='german'?'heute ist beintag und ich zeige dir mein training für den muskelaufbau mit der richtigen technik #gym':
      'ma séance de musculation #gym',
    last:kind==='dead'?200:1+(i%5)})}
const byH=Object.fromEntries(CR.map(c=>[c.h,c]));
const feedItem=c=>({id:c.h+'-'+Math.random().toString(36).slice(2),desc:c.cap,textLanguage:c.kind==='german'?'de':'fr',stats:{playCount:5000},
  author:{uniqueId:c.h,signature:c.bio,nickname:c.h},authorStats:{followerCount:c.f,heartCount:c.f*20,videoCount:100}});
let feedCalls=0;
function feedFor(url){feedCalls++;const seed=[...url].reduce((a,ch)=>a+ch.charCodeAt(0),0);
  return Array.from({length:60},(_,k)=>CR[(seed*7+k*13)%CR.length]).map(feedItem)}
const ssr=(id,obj)=>`<script id="${id}" type="application/json">${JSON.stringify(obj)}</script>`;
function tiktokPage(url){
  let m=url.match(/tiktok\.com\/embed\/@([^/?]+)/);
  if(m){const c=byH[m[1]];if(!c)return '';
    const vids=Array.from({length:10},(_,i)=>({id:tid(NOW-(c.last+i*2)*DAY,i),desc:c.cap,playCount:Math.round(c.f*(c.kind==='gym'?0.3:0.1))}));
    return ssr('__FRONTITY_CONNECT_STATE__',{source:{data:{['/embed/@'+c.h]:{userInfo:{followerCount:c.f,heartCount:c.f*20,signature:c.bio},videoList:vids}}}})}
  m=url.match(/tiktok\.com\/@([^/?]+)\/video\/(\d+)/);
  if(m){const c=byH[m[1]];if(!c)return '';
    return ssr('__UNIVERSAL_DATA_FOR_REHYDRATION__',{__DEFAULT_SCOPE__:{'webapp.video-detail':{itemInfo:{itemStruct:{id:m[2],stats:{playCount:1000,diggCount:60,commentCount:10,shareCount:5},
      textExtra:[{hashtagName:'musculation'},{userUniqueId:'c'+((+c.h.slice(1)+10)%400)}],music:{id:'777',title:'Gym Phonk',original:false}}}}}})}
  m=url.match(/tiktok\.com\/@([^/?]+)$/);
  if(m){const c=byH[m[1]];if(!c)return '<html>not found</html>';
    return ssr('__UNIVERSAL_DATA_FOR_REHYDRATION__',{__DEFAULT_SCOPE__:{'webapp.user-detail':{userInfo:{user:{uniqueId:c.h,nickname:c.h,signature:c.bio,language:'fr'},stats:{followerCount:c.f,heartCount:c.f*20,videoCount:100}}}}})}
  if(/\/discover\//.test(url))return '<html>no ssr</html>';
  return ''}
let ddgCalls=0,kapCalls=0;
function ddg(){ddgCalls++;return CR.filter((c,i)=>c.kind==='gym'&&i%7===0).map(c=>`<a href="https://www.tiktok.com/@${c.h}">x</a>`).join('')}

global.fetch=async(url,opts)=>{url=String(url);
  if(url.startsWith('https://app.test/api/research')){
    const op=new URL(url).searchParams.get('op');
    const r=await t.call('research',{method:(opts&&opts.method)||'GET',headers:(opts&&opts.headers)||{},query:{op},body:opts&&opts.body?JSON.parse(opts.body):undefined});
    return {ok:r.status<300,status:r.status,headers:{get:k=>r.headers[String(k).toLowerCase()]||null},json:async()=>r.json,text:async()=>r.raw}}
  if(/\/api\/seo\/kap\/video_list/.test(url)){kapCalls++;const off=+new URL(url).searchParams.get('offset');
    return {ok:true,status:200,headers:{get:()=>null},text:async()=>JSON.stringify({videoList:off<32?feedFor(url+off).slice(0,16):[],hasMore:off<16})}}
  if(/\/api\/seo\/kap\/related_keywords/.test(url))return {ok:true,status:200,headers:{get:()=>null},text:async()=>JSON.stringify({relatedKeywords:[{formattedWord:'seance musculation'}]})};
  if(/duckduckgo/.test(url))return {ok:true,status:200,headers:{get:()=>null},text:async()=>ddg()};
  if(/tiktok\.com/.test(url))return {ok:true,status:200,headers:{get:()=>null},text:async()=>tiktokPage(url)};
  if(/^https?:\/\/(linktr|example)/.test(url))return {ok:true,status:200,headers:{get:()=>null},text:async()=>''};
  return harnessFetch(url,opts)};

/* ── scripted model ───────────────────────────────────────────────────── */
const calls={plan:0,triage:0,vet:{haiku:0,sonnet:0},sup:0,report:0};
const rows=u=>u.split('\n').filter(l=>l.startsWith('{"h"')).map(l=>{try{return JSON.parse(l)}catch(e){return null}}).filter(Boolean);
const reply=(obj,usage)=>({ok:true,status:200,headers:{get:()=>null},json:async()=>({content:[{type:'text',text:JSON.stringify(obj)}],usage:usage||{input_tokens:3000,output_tokens:600}})});
t.anth.handle=async(url,opts)=>{
  const b=JSON.parse(opts.body);const sys=b.system.map(x=>x.text).join('');const u=b.messages[0].content;
  const haiku=/haiku/.test(b.model);
  if(/You plan TikTok/.test(sys)){calls.plan++;return reply({hashtags:'musculation:70 gymtok:65 legday:60',keywords:['programme musculation'],disqualifiers:['shop'],persona:'coach'})}
  if(/first-pass filter/.test(sys)){calls.triage++;return reply({results:rows(u).map(r=>({h:r.h,pass:/muscu|gym|coach/i.test(r.bio+r.cap),fit:/muscu|gym|coach/i.test(r.bio+r.cap)?80:10,why:'x'}))})}
  if(/senior influencer-marketing/.test(sys)){calls.vet[haiku?'haiku':'sonnet']++;
    return reply({results:rows(u).map(r=>{const coach=/coach/i.test(r.bio);
      return {h:r.h,verdict:coach?'accept':'maybe',score:haiku?(coach?88:70):(coach?90:80),niche:'musculation',fit:'real gym content',safety:'clean',flags:[],audience:'FR gym',style:'talking head',collab:'try-on',summary:'Très bon profil.'}})})}
  if(/You supervise/.test(sys)){calls.sup++;return reply({add:[{tag:'prepcoach',pri:70}],keywords:['coach prep'],note:'plus de prep'})}
  if(/research reports/.test(sys)){calls.report++;return reply({report:'Rapport final.'})}
  return reply({})};

/* ── a fake headless browser serving hashtag/sound feeds ─────────────── */
const chromium={launch:async()=>({close:async()=>{},newContext:async()=>({close:async()=>{},newPage:async()=>{
  let cb=null;
  return {on:(ev,f)=>{if(ev==='response')cb=f},
    goto:async u=>{if(/\/(tag|music)\//.test(u)&&cb){const api=/\/tag\//.test(u)?'https://www.tiktok.com/api/challenge/item_list/?x=1':'https://www.tiktok.com/api/music/item_list/?x=1';
      await cb({url:()=>api,json:async()=>({itemList:feedFor(u)})})}},
    mouse:{wheel:async()=>{}},$:async()=>null,content:async()=>'',close:async()=>{}}}})})};

(async()=>{
  const c=await t.call('research',{method:'POST',query:{op:'create'},body:{brief:{title:'Teveo test',brand:'Teveo',niche_summary:'musculation creators in France',
    markets:['FR'],languages:['fr'],followers:{min:10000,max:500000},target_count:25,max_cost_usd:50,machines:1}}});
  const id=c.json.id;
  const W=await import('../harvest/research-worker.mjs');
  const t0=Date.now();
  await W.main({chromium});
  const job=(await t.call('research',{query:{op:'job',id}})).json.job;
  const res=(await t.call('research',{query:{op:'results',id,limit:'100'}})).json;
  out.push(`one machine, synthetic TikTok (${((Date.now()-t0)/1000).toFixed(1)} s)`);
  ok(job.status==='done','job finishes on its own ('+job.status+')');
  ok(res.total>=25,'target reached with real accepted creators ('+res.total+')');
  ok(res.items.every(x=>byH[x.handle]&&byH[x.handle].kind==='gym'),'only on-niche, on-market, active creators accepted');
  ok(res.items.every(x=>x.followers>=10000&&x.followers<=500000),'all inside the follower band');
  ok(res.items.filter(x=>x.contacts&&x.contacts.email).length>=res.total*0.5,'emails extracted from bios');
  ok(res.items.every(x=>x.medViews>0&&x.engagementRate>0&&x.lastPostDays!=null),'real metrics on every result');
  ok(calls.plan===1&&calls.report===1,'planned once, final report written');
  ok(job.report==='Rapport final.','report visible in the app');
  const reasons=Object.fromEntries(job.strategy.reasons);
  ok(Object.keys(reasons).some(r=>/free check: (language|inactive)/.test(r)),'off-market / dead creators stopped by free checks ('+Object.keys(reasons).join(', ')+')');
  ok(calls.vet.sonnet>0&&calls.vet.haiku>calls.vet.sonnet,'Haiku vets the bulk, Sonnet only the close calls ('+JSON.stringify(calls.vet)+')');
  ok(kapCalls>0,'TikTok keyword lists used, not only hashtags ('+kapCalls+' pages)');
  ok(ddgCalls>0,'web search tried as a bonus');
  const pool=(await t.call('research',{query:{op:'pool'}})).json.creators;
  ok(pool>50,'creator base filled for the next search ('+pool+')');
  const seen=t.redis.store.get('cadence:rs:seen:'+id)||[];
  ok(seen.length===new Set(seen).size&&seen.length>0,'shared seen-set populated, no duplicates ('+seen.length+')');
  ok(job.stats.costUsd>0&&job.stats.costUsd<job.brief.max_cost_usd,'AI cost metered and under budget ($'+job.stats.costUsd+')');

  // second search on the same niche starts from the creator base
  const c2=await t.call('research',{method:'POST',query:{op:'create'},body:{brief:{title:'Brand B',niche_summary:'coach musculation',markets:['FR'],languages:['fr'],
    followers:{min:10000,max:500000},target_count:15,max_cost_usd:50,machines:1}}});
  const feed0=feedCalls;
  const W2=await import('../harvest/research-worker.mjs?second');
  await W2.main({chromium});
  const j2=(await t.call('research',{query:{op:'job',id:c2.json.id}})).json.job;
  out.push('second search, same niche');
  ok(j2.status==='done'&&j2.stats.poolHits>0,'re-used the creator base ('+j2.stats.poolHits+' known creators)');
  ok(feedCalls-feed0<feed0,'needed less crawling than the first search ('+(feedCalls-feed0)+' vs '+feed0+' feeds)');

  console.log(out.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
})().catch(e=>{console.error(e);process.exit(1)});
