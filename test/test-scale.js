// Scale tests: 5,000 creators end to end.  node test/test-scale.js
const fs=require('fs'),path=require('path');const {JSDOM}=require('jsdom');const FIDB=require('fake-indexeddb');
const {setup,tool,say,toolResult,FULL}=require('./harness');
const A=require('../api/_analytics');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
let pass=0,fail=0;const out=[];
const ok=(c,m)=>{if(c){pass++;out.push('  ✓ '+m)}else{fail++;out.push('  ✗ '+m)}};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const N=5000;

function boot(srv,{idb,ls}={}){
  const factory=idb||new FIDB.IDBFactory();
  const dom=new JSDOM(html,{runScripts:'dangerously',url:'https://cadence-app-amber.vercel.app/',pretendToBeVisual:true,
    beforeParse(w){w.__noTimers=true;w.indexedDB=factory;w.IDBKeyRange=FIDB.IDBKeyRange;
      w.alert=()=>{};w.confirm=()=>true;w.scrollTo=()=>{};w.open=()=>{};w.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};
      if(ls!=null)w.localStorage.setItem('cadence',ls);
      w.fetch=async(url,opts={})=>{const m=String(url).match(/\/api\/(\w+)/);
        if(m&&srv){const r=await srv.call(m[1],{method:opts.method||'GET',headers:opts.headers||{},body:opts.body?JSON.parse(opts.body):undefined});
          return {status:r.status,ok:r.status<300,headers:{get:k=>r.headers[k.toLowerCase()]||null},json:async()=>r.json}}
        return {status:200,headers:{get:()=>null},json:async()=>({})}}}});
  const w=dom.window;return {w,E:x=>w.eval(x),factory,close:()=>w.close()}}

/* 5,000 creators with a realistic spread of stages, views, keywords, platforms. */
const GEN=`(()=>{const N=${N},now=Date.now(),D=86400000;const stages=['contacted','contacted','contacted','replied','negotiating','address_needed','address_ready','shipped','live_pending','live_ok','declined'];
  const kws=['asmr sleep','sleep routine','insomnia','melatonin','night skincare'];const pipe={},sent=[],reps=[];
  for(let i=0;i<N;i++){const id=(i%3?'youtube:':'tiktok:')+'c'+i;const st=stages[i%stages.length];const views=[3000,12000,35000,90000,240000,800000][i%6];
    pipe[id]={id,name:'Creator '+i,email:'c'+i+'@x.co',handle:'@c'+i,platform:i%3?'youtube':'tiktok',stage:st,views,kw:kws[i%5],country:i%4?'US':'GB',
      addr:['address_ready','shipped','live_pending','live_ok'].includes(st)?{line1:'1 St',city:'X',country:'US'}:null,videoUrl:st.startsWith('live')?'https://youtu.be/v'+i:'',
      shippedAt:'',log:[{at:new Date(now-(i%30)*D).toISOString(),msg:'x'}]};
    sent.push({id,name:'Creator '+i,email:'c'+i+'@x.co',views,at:new Date(now-(i%30)*D).toISOString(),ok:i%50!==0,gmThreadId:'t'+i});
    if(st!=='contacted')reps.push({gmId:'r'+i,creatorId:id,name:'Creator '+i,email:'c'+i+'@x.co',subject:'Re',body:'Thanks for reaching out — '.repeat(60),
      intent:st==='declined'?'DECLINE':st==='negotiating'?'NEGOTIATE':'INTERESTED',status:'sent',at:new Date(now-(i%20)*D).toISOString()})}
  db.pipe=pipe;db.out.sent=sent;inboxCfg().replies=reps;
  for(let i=0;i<500;i++)emit('stage_changed',{id:'youtube:c'+(i*3+1),stage:'replied'});
  save();return JSON.stringify({creators:Object.keys(pipe).length,replies:reps.length,blob:JSON.stringify(db).length})})()`;

(async()=>{
  out.push('storage at 5,000 creators');
  let idb,ls,info;
  {const srv=setup({});const t=boot(srv);await t.E('stateReadyP');
   info=JSON.parse(t.E(GEN));await t.E('persistHeavy()');
   ok(info.blob>5000000,`the full account is ${(info.blob/1e6).toFixed(1)} MB — over the ~5 MB browser storage limit that silently dropped saves before`);
   ls=t.w.localStorage.getItem('cadence');
   ok(ls&&ls.length<200000&&JSON.parse(ls)._split===1,`settings in localStorage only (${Math.round(ls.length/1024)} KB)`);
   ok(!t.E('stateStats().warn'),'no storage warning');
   idb=t.factory;t.close()}
  {const srv=setup({});const t=boot(srv,{idb,ls});await t.E('stateReadyP');
   const s=JSON.parse(t.E('JSON.stringify(stateStats())'));
   ok(s.creators===N&&s.sent===N&&s.replies===info.replies,`reload: ${s.creators} creators, ${s.sent} emails, ${s.replies} replies — nothing lost`);
   ok(s.mode==='IndexedDB','collections read back from IndexedDB');
   ok(t.E("db.ai.events.filter(e=>e.type==='stage_changed').length")>=500,'event stream survives the reload');
   t.close()}
  {const srv=setup({});const legacy=JSON.stringify({campaigns:[],pipe:{a:{id:'a',name:'Ana',stage:'contacted',log:[]}},out:{rate:5,sent:[{id:'a',ok:true,at:new Date().toISOString()}],queue:[]},ai:{}});
   const t=boot(srv,{ls:legacy});await t.E('stateReadyP');await wait(20);
   const after=JSON.parse(t.w.localStorage.getItem('cadence'));
   ok(t.E("db.pipe.a.name")==='Ana'&&after._split===1&&!after.pipe,'an older account (everything in localStorage) moves to IndexedDB on first start');
   const t2=boot(srv,{idb:t.factory,ls:t.w.localStorage.getItem('cadence')});await t2.E('stateReadyP');
   ok(t2.E("db.pipe.a.name")==='Ana'&&t2.E("db.out.sent.length")===1,'…and reloads intact from there');t.close();t2.close()}

  out.push('analysis over 5,000 creators');
  {const srv=setup({});const t=boot(srv,{idb,ls});await t.E('stateReadyP');
   let t0=Date.now();
   const q=JSON.parse(t.E("JSON.stringify(OPS_TOOLS.query_creators.run({stage:'contacted',silent_days_min:10,platform:'youtube',sort:'views',limit:50}))"));
   const ms=Date.now()-t0;
   const truth=t.E("Object.values(db.pipe).filter(p=>p.stage==='contacted'&&p.platform==='youtube'&&Math.floor((Date.now()-new Date(p.log[0].at))/86400000)>=10).length");
   ok(q.total===truth&&q.creators.length===50,`query_creators: ${q.total} silent YouTube contacts found, matches a manual count (${truth})`);
   ok(q.creators[0].views>=q.creators[49].views,'sorted by views');
   ok(ms<400,`answered in ${ms} ms`);
   const seg=JSON.parse(t.E("JSON.stringify(OPS_TOOLS.get_segments.run({dimension:'views_band'}))"));
   const b=seg.segments.find(s=>s.segment==='20–50k');
   const manual=t.E("(()=>{const ok=new Set(db.out.sent.filter(s=>s.ok).map(s=>s.id));const l=Object.values(db.pipe).filter(p=>p.views===35000&&ok.has(p.id));const rep=new Set(inboxCfg().replies.map(r=>r.creatorId));return JSON.stringify({n:l.length,r:l.filter(p=>rep.has(p.id)||p.stage!=='contacted').length})})()");
   const mm=JSON.parse(manual);
   ok(b&&b.creators===mm.n&&Math.abs(b.reply_rate-Math.round(mm.r/mm.n*1000)/10)<0.11,`segments by views band exact (20–50k: ${b&&b.creators} creators, ${b&&b.reply_rate}% reply)`);
   const kw=JSON.parse(t.E("JSON.stringify(OPS_TOOLS.get_segments.run({dimension:'keyword'}))"));
   ok(kw.segments.length===5&&kw.segments.every(s=>s.creators>=900),'segments by discovery keyword');
   const bad=JSON.parse(t.E("JSON.stringify(OPS_TOOLS.get_segments.run({dimension:'shoe_size'}))"));
   ok(bad.error,'unknown dimension returns an error the model can correct');
   ok(t.E("OPS_TOOL_DEFS().some(d=>d.name==='query_creators')&&OPS_TOOL_DEFS().some(d=>d.name==='get_segments')"),'both exposed to Sonnet');
   ok(/DATA MODEL/.test(t.E('opsSystem()')),'the agent is given the data model in its instructions');
   t.close()}

  out.push('one creator, linked everywhere');
  {const srv=setup({});const t=boot(srv);await t.E('stateReadyP');
   t.E(`pipeRec({id:'youtube:nora',name:'Nora',email:'n@q.co',platform:'youtube',medViews:48200,subs:61000,kw:'asmr sleep',country:'US'})`);
   ok(t.E("JSON.stringify([db.pipe['youtube:nora'].views,db.pipe['youtube:nora'].kw,db.pipe['youtube:nora'].country])")==='[48200,"asmr sleep","US"]','creator record keeps views, keyword and country from discovery');
   t.E(`db.campaigns=[{id:'c1',product:'Mood',rate:5,budget:10000,creators:[{id:'k1',pid:'youtube:nora',name:'Nora',rate:5}],videos:[{id:'v1',cr:'k1',views:300000,paid:100000}],history:[]}]`);
   const c=JSON.parse(await t.E("OPS_TOOLS.get_creator.run({id:'youtube:nora'}).then(JSON.stringify)"));
   ok(c.campaigns&&c.campaigns[0].views===300000&&c.campaigns[0].owed===1000,'get_creator joins campaign views and money owed through the creator id');
   ok(/pid:r\.id/.test(html)&&/pid:l\.id/.test(html),'adding creators to a campaign keeps the link (roster and bulk add)');
   t.close()}

  out.push('volume in the stream and the sync');
  {const srv=setup(FULL);const t=boot(srv);await t.E('stateReadyP');await wait(30);
   t.E("for(let i=0;i<800;i++)emit('email_sent',{id:'x'+i,name:'X'+i,count:1})");
   ok(t.E("db.ai.events.filter(e=>e.type==='email_sent').length")===1&&t.E("db.ai.events[0].data.count")===800,'800 sends in a row become one event (count 800)');
   t.E(GEN);
   let pushed=0,rounds=0;
   while(rounds<60){const r=JSON.parse(await t.E("syncNow().then(JSON.stringify)"));rounds++;if(r.error){ok(false,'sync error '+r.error);break}
     pushed+=r.pushed||0;if(!r.pushed&&!r.events)break}
   const inRedis=srv.redis.store.get('cadence:rec:pipe').size;
   ok(inRedis===N,`5,000 creators reach the server in ${rounds-1} batches (≤1,000 records each) — ${inRedis} stored`);
   t0=Date.now();const st=await srv.h('agent')._internal.loadState();const lt=Date.now()-t0;
   ok(Object.keys(st.pipe).length===N&&lt<1500,`server loads the full copy in ${lt} ms`);
   const T=srv.h('agent')._internal.tools(st);
   const seg=T.get_segments.r({dimension:'platform'});
   ok(seg.segments.length===2&&seg.total_creators>4800,`server-side segments over ${seg.total_creators} creators`);
   const q=T.query_creators.r({stage:['negotiating','address_needed'],limit:10});
   ok(q.total===Object.values(st.pipe).filter(p=>['negotiating','address_needed'].includes(p.stage)).length,'server-side query_creators matches');
   srv.anth.scripts.server=[
     ()=>tool('get_segments',{dimension:'views_band'},'s'),
     b=>{const r=toolResult(b,'s');return tool('record_insight',{title:'Daily brief',detail:`best band ${r.segments.sort((x,y)=>y.reply_rate-x.reply_rate)[0].segment}`,category:'general'},'i')},
     ()=>say('Done.')];
   const run=await srv.call('agent',{method:'POST',body:{}});
   ok(run.status===200,`server agent completes over 5,000 creators (${run.json.situations} situations found by the scan)`);
   const first=srv.anth.calls.find(c=>/running on the server/.test(c.body.system[0].text));
   ok(first&&first.body.messages[0].content.split('Data audit')[0].split('\n- ').length<=17,'the scan hands the model at most 15 situations per run — the rest wait for the next run');
   t.close()}

  console.log(out.join('\n'));console.log(`\n${pass} passed, ${fail} failed`);process.exit(fail?1:0)
})().catch(e=>{console.log(out.join('\n'));console.error('CRASH',e);process.exit(2)});
let t0;
