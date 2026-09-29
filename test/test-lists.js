// End-to-end: the real index.html in jsdom, talking to the real /api handlers
// (in-process) backed by a fake Redis and a fake Anthropic.  node test/test-app.js
const fs=require('fs'),path=require('path');const {JSDOM}=require('jsdom');const FIDB=require('fake-indexeddb');
const {setup,tool,say,toolResult,FULL}=require('./harness');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
let pass=0,fail=0;const out=[];
const ok=(c,m)=>{if(c){pass++;out.push('  ✓ '+m)}else{fail++;out.push('  ✗ '+m)}};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const iso=d=>new Date(Date.now()-d*86400000).toISOString();

function boot(env,preset){
  const srv=setup(env);const browserCalls=[];const opened=[];
  const dom=new JSDOM(html,{runScripts:'dangerously',url:'https://cadence-app-amber.vercel.app/',pretendToBeVisual:true,
    beforeParse(w){
      w.__noTimers=true;w.indexedDB=new FIDB.IDBFactory();w.IDBKeyRange=FIDB.IDBKeyRange;
      w.alert=()=>{};w.confirm=()=>true;w.scrollTo=()=>{};w.open=u=>{opened.push(u)};
      w.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};
      if(preset)w.localStorage.setItem('cadence',JSON.stringify(preset));
      w.fetch=async(url,opts={})=>{url=String(url);browserCalls.push({url,opts});
        const m=url.match(/^(?:https:\/\/cadence-app-amber\.vercel\.app)?\/api\/(\w+)/);
        if(m){const r=await srv.call(m[1],{method:opts.method||'GET',headers:opts.headers||{},body:opts.body?JSON.parse(opts.body):undefined});
          return {status:r.status,ok:r.status<300,headers:{get:k=>r.headers[k.toLowerCase()]||null},json:async()=>r.json}}
        if(url.includes('googleapis.com/youtube')){const has=url.includes('HASLINK');
          return {status:200,json:async()=>({items:[{snippet:{description:has?'get it at mood.co':'no link here',title:'v'},statistics:{viewCount:'50000'}}]})}}
        return {status:200,json:async()=>({})}};
    }});
  const w=dom.window;const E=x=>w.eval(x);
  return {w,E,srv,browserCalls,opened,close:()=>w.close()}}
const settle=async t=>{await wait(30);await t.E('aiIdle()');await wait(10)};

function seed(extra){return Object.assign({
  brand:{product:'Mood gummies',url:'https://mood.co',market:'US',price:'29'},
  campaigns:[{id:'c1',product:'Mood gummies',budget:10000,status:'live',rate:5,
    creators:[{id:'k1',name:'Nora',rate:5},{id:'k2',name:'Vesper',rate:5}],
    videos:[{id:'v1',cr:'k1',views:1200000,paid:0,yt:'aaaaaaaaaaa',url:'https://youtu.be/aaaaaaaaaaa',title:'Night routine'},{id:'v2',cr:'k2',views:600000,paid:0,url:'https://youtu.be/bbbbbbbbbbb',title:'ASMR'}],history:[]}],
  out:{fromName:'Louis Bouyer',fromEmail:'louis@mood.co',replyTo:'',rate:5,subject:'An idea',body:'Hi {{name}}',
    startHour:0,endHour:24,perDay:40,minGapMin:6,queue:[],
    sent:[{id:'a',name:'Ana',email:'ana@x.co',views:40000,at:iso(7),ok:true,gmThreadId:'tA'},
          {id:'n',name:'Nora Quill',email:'nora@q.co',views:48200,at:iso(3),ok:true,gmThreadId:'tN'}],
    running:false,nextAt:0,inbox:{mode:'semi',replies:[],lastSync:0}},
  mail:{provider:'manual',tok:null,verified:null},
  ai:{key:'sk-ant-OLD-browser-key',model:'claude-opus-4-1',auto:{on:true}},
  pipe:{a:{id:'a',name:'Ana',email:'ana@x.co',handle:'@ana',platform:'youtube',stage:'contacted',addr:null,videoUrl:'',shippedAt:'',log:[{at:iso(7),msg:'First email sent'}]},
        g:{id:'g',name:'Gus',email:'gus@x.co',handle:'@gus',platform:'youtube',stage:'negotiating',addr:null,videoUrl:'',shippedAt:'',log:[{at:iso(1),msg:'Replied — negotiating'}]},
        n:{id:'n',name:'Nora Quill',email:'nora@q.co',handle:'@nora',platform:'youtube',stage:'contacted',addr:null,videoUrl:'',shippedAt:'',log:[{at:iso(3),msg:'First email sent'}]}},
},extra||{})}

(async()=>{
  out.push('save + classify a list');
  {const t=boot(FULL,seed());await wait(40);await settle(t);
   t.srv.anth.scripts.ops=[]; // classify_creators isn't scripted, handled by the harness's classify_replies-style branch below? no — add generic handler
   const r=await t.E(`(async()=>{
     PLAT='youtube';
     const items=[
       {id:'l1',name:'Nora Sleeps',handle:'@norasleeps',platform:'youtube',email:'nora@x.co',url:'https://x/l1',subs:42000,medViews:18000,kw:'sleep gummies',country:'US'},
       {id:'l2',name:'Gus Fitness',handle:'@gusfit',platform:'youtube',email:'',url:'https://x/l2',subs:120000,medViews:60000,kw:'sleep gummies',country:'CA'},
     ];
     const list=await saveList('Sleep niche batch 1',items,{platform:'youtube',filters:{kw:'sleep gummies'}});
     return JSON.stringify({id:list.id,count:list.items.length,name:list.name})
   })()`);
   const info=JSON.parse(r);
   ok(info.count===2&&info.name==='Sleep niche batch 1','saveList stores every item, keeps the given name ('+r+')');
   ok(t.E("db.lists.length")===1,'the list is in db.lists');
   await settle(t);await wait(30);
   ok(t.E(`db.lists[0].items.every(it=>it.category)`),'every creator got an AI category (no guessing — the model tagged all of them) ('+t.E('JSON.stringify(db.lists[0].items.map(i=>[i.id,i.category,i.tier]))')+')');
   ok(!!t.E('db.lists[0].summary'),'the list got an AI one-line summary');
   t.E("show('lists')");const h=t.E("document.getElementById('listsBody').innerHTML");
   ok(h.includes('Sleep niche batch 1')&&h.includes('2'),'the Lists view renders the saved list');
   t.close()}

  out.push('unclassifiable when AI is offline');
  {const t=boot({},seed());await wait(40); // no ANTHROPIC_API_KEY in this env → aiReady() is false
   const r=await t.E(`(async()=>{
     const items=[{id:'m1',name:'Ana',handle:'@ana',platform:'youtube',email:'',url:'',subs:1000,medViews:500}];
     const list=await saveList('Offline test',items,{});
     return JSON.stringify({count:list.items.length,cat:list.items[0].category})
   })()`);
   const info=JSON.parse(r);
   ok(info.count===1&&info.cat==='','saved even with no AI backend — nothing invented, category left blank');
   ok(/not connected/i.test(t.E("db.lists[0].summary")||''),'the list says plainly that it could not be classified');
   t.close()}

  out.push('save from Discover selection (UI path)');
  {const t=boot(FULL,seed());await wait(40);await settle(t);
   await t.E(`idbUpsert([{id:'d1',name:'Vex',handle:'@vex',platform:'youtube',email:'vex@x.co',url:'https://x/d1',subs:9000,medViews:4000,score:80,kw:'sleep',status:'new',hits:1,last:new Date().toISOString(),seenAt:Date.now()},
     {id:'d2',name:'Rae',handle:'@rae',platform:'youtube',email:'rae@x.co',url:'https://x/d2',subs:15000,medViews:7000,score:65,kw:'sleep',status:'new',hits:1,last:new Date().toISOString(),seenAt:Date.now()}])`);
   await t.E("loadPage()");await wait(20);
   t.E("sel=new Set(['d1','d2'])");
   t.E("window.prompt=()=>'Discover picks'");
   await t.E("bulkSaveList()");await settle(t);await wait(20);
   ok(t.E("db.lists.some(l=>l.name==='Discover picks'&&l.items.length===2)"),'Save as list in Discover captures the exact selection, not the whole page');
   t.close()}

  out.push('synced to the server and readable by the agent');
  {const t=boot(FULL,seed());await wait(40);await settle(t);
   await t.E(`(async()=>{
     const items=[{id:'s1',name:'Zoe',handle:'@zoe',platform:'tiktok',email:'zoe@x.co',url:'',subs:30000,medViews:12000,country:'GB'}];
     await saveList('Cloud check',items,{})})()`);
   await settle(t);await t.E("syncNow()");await wait(20);
   const synced=t.srv.redis.store.get('cadence:rec:list');
   ok(synced&&synced.size===1,'the list reached Redis via /api/sync, keyed by list id');
   // the same server-side tool the daily supervisor and Copilot use:
   const agentApi=require(require('path').join(__dirname,'..','api','agent.js'));
   const st=await agentApi._internal.loadState();
   const T=agentApi._internal.tools(st);
   const got=T.get_lists.r();
   ok(got.total===1&&got.lists[0].name==='Cloud check','the server agent can read saved lists via get_lists, cloud round-trip proven');
   t.close()}

  console.log(out.join('\n'));console.log(`\n${pass} passed, ${fail} failed`);process.exit(fail?1:0)
})().catch(e=>{console.error(e);process.exit(1)});
