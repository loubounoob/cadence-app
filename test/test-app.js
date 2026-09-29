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
  out.push('key stays on the server');
  {const t=boot(FULL,seed());await wait(40);
   ok(!/sk-ant-/.test(html)&&!/Anthropic API key<\/label>/.test(html),'no key and no key field anywhere in the page');
   ok(t.E('db.ai.key')===undefined,'an old key saved in the browser is deleted on load');
   ok(t.E('aiReady()')===true,'page sees the backend key through /api/health');
   await t.E("runAgent('outreach','hello',50)");
   const call=t.browserCalls.find(c=>c.url==='/api/ai');
   ok(call&&!JSON.stringify(call.opts.headers).includes('x-api-key'),'browser calls /api/ai with no key header');
   ok(!t.browserCalls.some(c=>c.url.includes('api.anthropic.com')),'browser never calls Anthropic directly');
   ok(t.srv.anth.calls.at(-1).body.model==='claude-sonnet-5'&&t.srv.anth.calls.at(-1).headers['x-api-key']==='sk-ant-SECRET-test-key','server adds the key and forces Sonnet');
   t.E("show('ai')");const h=t.E("document.getElementById('aiBody').innerHTML");
   ok(h.includes('held by the server')&&!/sk-ant/.test(h)&&h.includes('Server memory'),'Copilot shows backend status, no key input');
   t.close()}
  {const t=boot({},seed());await wait(40);
   ok(t.E('aiReady()')===false,'backend without key → AI marked offline');
   t.E("show('ai')");ok(t.E("document.getElementById('aiBody').innerHTML").includes('Environment Variables'),'Copilot says exactly where to add the key');
   let err='';try{await t.E("runAgent('outreach','x')")}catch(e){err=e.message}
   ok(/ANTHROPIC_API_KEY/.test(err),'calls fail with a clear message instead of asking for a key');t.close()}

  out.push('every feature reports to the agent');
  {const rules=Object.keys(new JSDOM('').window.eval?{}:{});
   const types=[...html.matchAll(/^\s{2}(\w+):\{route:'(now|batch|ignore)'/gm)].map(m=>m[1]).filter(x=>x!=='app_error');
   const missing=types.filter(tp=>!new RegExp(`emit\\([^)]*'${tp}'`).test(html)&&!(tp==='payout'&&/aiEmit\('payout'/.test(html))&&!(tp==='reply_triaged'&&/aiEmit\('reply_triaged'/.test(html)));
   ok(types.length>=22&&!missing.length,`all ${types.length} event types are emitted somewhere in the app${missing.length?' — missing: '+missing.join(', '):''}`)}
  {const t=boot(FULL,seed({ai:{auto:{on:false}}}));await wait(40);
   t.E("setStage(db.pipe.a,'replied','test')");
   ok(t.E("db.ai.events[0].type")==='stage_changed'&&t.E("db.ai.events[0].data.from")==='contacted','stage change → stage_changed event with from/to');
   await t.E("idbUpsert([{id:'L1',platform:'tiktok',kw:'asmr sleep',hits:1,last:''},{id:'L2',platform:'tiktok',kw:'asmr',hits:1,last:''}])");
   await t.E("idbUpsert([{id:'L3',platform:'tiktok',kw:'asmr',hits:1,last:''}])");
   ok(t.E("db.ai.events[0].type")==='leads_saved'&&t.E("db.ai.events[0].data.added")===3&&t.E("db.ai.events[0].data.count")===2,'discovery saves → one merged leads_saved event (3 new over 2 runs)');
   t.E("cur=db.campaigns[0];setV('v2','700000')");
   ok(t.E("db.ai.events[0].type")==='views_updated'&&t.E("db.ai.events[0].data.views")===1900000,'view update → views_updated with campaign total');
   t.E("markShipped('a')");ok(t.E("db.ai.events.slice(0,3).map(e=>e.type).join()").includes('shipped'),'marking shipped → shipped event');
   t.E("db.pipe.a.videoUrl='https://youtu.be/HASLINK1234';db.pipe.a.stage='live_pending'");
   await t.E("checkCompliance(db.pipe.a,true)");
   ok(t.E("db.ai.events.slice(0,3).map(e=>e.type).join()").includes('video_ok'),'compliance pass → video_ok');
   t.E("db.pipe.n.videoUrl='https://youtu.be/NOLINK12345';db.pipe.n.stage='live_pending'");
   await t.E("checkCompliance(db.pipe.n,true)");
   ok(t.E("db.ai.events.some(e=>e.type==='video_missing_link'&&e.data.id==='n')"),'compliance fail → video_missing_link (route now)');
   t.E("db.out.queue=[{id:'q1',name:'Q',email:'q@x.co'}];db.out.running=true;db.out.nextAt=0;db.mail.provider='manual'");
   t.E("sendOne=async()=>({ok:false,err:'550 mailbox unavailable'})");await t.E("outTick()");await wait(20);
   ok(t.E("db.ai.events.some(e=>e.type==='email_failed'&&/550/.test(e.data.err))"),'failed send → email_failed with the error');
   t.close()}

  out.push('routing, digest, insights');
  {const t=boot(FULL,seed());await wait(40);await settle(t);
   t.srv.anth.calls.length=0;
   for(let i=0;i<24;i++)t.E(`emit('leads_status',{count:${i},status:'rejected'})`);
   ok(t.srv.anth.calls.length===0,'batch events cost nothing until the digest');
   t.srv.anth.scripts.ops=[
     b=>{ok(/25 events|24 events|events, oldest first/.test(b.messages[0].content),'digest prompt carries the batched stream');return tool('get_metrics',{},'m')},
     b=>{const m=toolResult(b,'m');return tool('record_insight',{title:`Reply rate ${m.reply_rate_pct}%`,detail:'Rejections piling up in discovery',category:'discovery',priority:'high'},'r')},
     ()=>say('Mostly routine; one pattern.')];
   t.E(`emit('leads_status',{count:99,status:'rejected'})`);
   await settle(t);
   ok(t.E("db.ai.events.filter(e=>!e.digested).length")===0,'25th batched event triggers the digest and marks the batch read');
   ok(t.E("db.ai.insights[0].title").startsWith('Reply rate')&&t.E("db.ai.insights[0].priority")==='high','Sonnet reads the batch, checks numbers, records an insight');
   t.E("show('ai')");const h=t.E("document.getElementById('aiBody').innerHTML");
   ok(h.includes('What the agent noticed')&&h.includes('Reply rate')&&h.includes('Live stream'),'insight feed and live stream rendered in Copilot');
   const m=t.E("JSON.stringify(metrics())");const mm=JSON.parse(m);
   ok(mm.sent_total===2&&mm.funnel.contacted===3,'get_metrics computes sends and funnel from live data');
   const ev=JSON.parse(t.E("JSON.stringify(OPS_TOOLS.get_events.run({type:'leads_status',limit:5}))"));
   ok(ev.total===25&&ev.events.length===5,'get_events filters the stream by type');
   t.close()}

  out.push('real-time reactions');
  {const t=boot(FULL,seed());await wait(40);await settle(t);
   t.srv.anth.scripts.ops=[
     ()=>tool('get_creator',{id:'n'},'g'),
     b=>tool('propose_email',{creator_id:'n',kind:'counter_offer',body:'We keep $5 per 1,000 views — about $240 a video at your median.',reason:'asked for flat fee'},'p'),
     ()=>tool('flag_for_human',{creator_id:'n',reason:'Wants a flat fee — recommend hold',priority:'high'},'f'),
     ()=>say('Counter filed, flagged.')];
   await t.E("addManualReply('n','Love it, but I need a $500 flat fee per video.')");await settle(t);
   ok(t.E("db.pipe.n.stage")==='negotiating','reply pasted from outside Gmail → triaged NEGOTIATE → stage negotiating');
   const ap=t.E("JSON.stringify(db.ai.approvals.map(x=>x.type+':'+x.kind))");
   ok(ap.includes('email:counter_offer')&&ap.includes('todo:'),'agent reacted at once: counter-offer for approval + flagged ('+ap+')');
   ok(t.opened.length===0,'nothing sent to the creator');
   t.srv.anth.scripts.ops=[()=>say('Address saved.')];
   await t.E("addManualReply('a','Yes please! Nora Quill, 12 Rue Oberkampf, 75011 Paris, France')");await settle(t);
   ok(t.E("db.pipe.a.stage")==='address_ready'&&t.E("db.pipe.a.addr.city")==='Paris','interested reply with an address → captured, ready to ship');
   const id=t.E("db.ai.approvals.find(x=>x.kind==='counter_offer').id");
   t.E("show('ai')");await t.E(`approve('${id}')`);
   ok(t.opened.length===1&&t.opened[0].startsWith('mailto:nora%40q.co'),'approving in manual-mailbox mode opens your mail app with the text');
   ok(t.E("db.ai.events.some(e=>e.type==='approval_decided')"),'your decision is itself an event the agent can learn from');
   const neg=await t.E(`(async()=>{inboxCfg().replies.push({gmId:'r9',creatorId:'g',name:'Gus',email:'gus@x.co',subject:'Re',body:'more money',intent:'NEGOTIATE',status:'ready',aiDraft:'ok'});db.ai.auto.autoSend.push('NEGOTIATE');return JSON.stringify(await OPS_TOOLS.send_reply.run({reply_id:'r9'}))})()`);
   ok(JSON.parse(neg).queued_for_approval,'a negotiation is never auto-sent, even if you add it to auto-send');
   const bad=JSON.parse(await t.E("OPS_TOOLS.propose_email.run({creator_id:'g',kind:'counter_offer',body:'On monte à 8 € les 1 000 vues.',reason:'x'}).then?0:JSON.stringify(OPS_TOOLS.propose_email.run({creator_id:'g',kind:'counter_offer',body:'On monte à 8 € les 1 000 vues.',reason:'x'}))"));
   ok(bad.error&&/ceiling/.test(bad.error),'rate ceiling enforced in code (French phrasing too)');
   t.close()}

  out.push('omnipresent: server keeps working while the app is closed');
  {const t=boot(FULL,seed());await wait(60);await settle(t);
   ok(t.E("db.ai.backend.storage")===true,'app detects server memory');
   const s1=JSON.parse(await t.E("syncNow().then(JSON.stringify)"));
   ok(t.srv.redis.store.get('cadence:rec:pipe').size===3&&t.srv.redis.store.get('cadence:rec:camp').size===1&&t.srv.redis.store.get('cadence:rec:sent').size===2,'app syncs every record to the server on start');
   const s2=JSON.parse(await t.E("syncNow().then(JSON.stringify)"));
   ok(s2.pushed===0,'second sync pushes nothing when nothing changed (delta by hash)');
   t.E("setStage(db.pipe.g,'declined','test')");
   const s3=JSON.parse(await t.E("syncNow().then(JSON.stringify)"));
   ok(s3.pushed===1&&s3.events>=1,'one change → one record and its event pushed');
   // app "closed": server agent runs on the synced copy
   t.srv.anth.scripts.server=[
     ()=>tool('propose_email',{creator_id:'a',kind:'follow_up',body:'Quick follow-up — $5 per 1,000 views, paid weekly. Worth a look?',reason:'7 days silent'},'p'),
     ()=>tool('record_insight',{title:'Daily brief',detail:'2 sent, 1 declined, budget 90%',category:'general'},'i'),
     ()=>say('One follow-up filed.')];
   const run=await t.srv.call('agent',{method:'POST',body:{source:'cron'}});
   ok(run.status===200&&run.json.ops>=2,'server agent ran on the synced copy and produced operations');
   const s4=JSON.parse(await t.E("syncNow().then(JSON.stringify)"));
   ok(s4.ops>=3,'next sync pulls the server operations back into the app');
   ok(t.E("db.ai.approvals.some(x=>x.kind==='follow_up'&&x.creatorId==='a'&&x.source==='server')"),'follow-up written by the server shows up in Needs your OK');
   ok(t.E("db.ai.insights.some(i=>i.title==='Daily brief'&&i.source==='server')"),'server daily brief shows up in the insight feed');
   ok(t.E("!!(db.ai.flags.a&&db.ai.flags.a.followUp)"),'server flags merged — the app will not send a second follow-up');
   ok(t.E("db.out.ailog.some(x=>/Server agent/.test(x.msg))"),'server run logged in Activity');
   await t.E("syncNow()");
   ok(t.srv.redis.store.get('cadence:ops').size===0,'operations acknowledged and cleared on the server');
   t.srv.anth.calls.length=0;t.E("aiScan(true)");await settle(t);
   ok(!t.srv.anth.calls.some(c=>/creator_id=a got our first email/.test(JSON.stringify(c.body.messages))),'app scanner skips what the server already handled');
   t.close()}

  console.log(out.join('\n'));console.log(`\n${pass} passed, ${fail} failed`);process.exit(fail?1:0)
})().catch(e=>{console.log(out.join('\n'));console.error('CRASH',e);process.exit(2)});
