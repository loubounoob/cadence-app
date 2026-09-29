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
  out.push('triage: structured, batched, checked');
  {const t=boot(FULL,seed());await wait(40);await settle(t);t.srv.anth.scripts.ops=[];
   // 30 replies from 30 creators
   t.E(`for(let i=0;i<30;i++){db.pipe['c'+i]={id:'c'+i,name:'C'+i,email:'c'+i+'@x.co',stage:'contacted',log:[{at:new Date().toISOString(),msg:'First email sent'}]};
     inboxCfg().replies.push({gmId:'m'+i,creatorId:'c'+i,name:'C'+i,email:'c'+i+'@x.co',subject:'Re',at:new Date().toISOString(),status:'new',
       body:i%3===0?'I need more money, a flat fee':i%3===1?'How long do I have to post?':'Sounds good, count me in'})}`);
   t.srv.anth.classifyCalls=0;
   await t.E('triageAllNew()');await settle(t);
   ok(t.srv.anth.classifyCalls===3,'30 replies classified in 3 calls, not 30 ('+t.srv.anth.classifyCalls+')');
   ok(t.E("inboxCfg().replies.filter(r=>/^m/.test(r.gmId)&&r.status==='ready').length")===30,'every reply triaged, none left behind');
   ok(t.E("[0,3,6].every(i=>db.pipe['c'+i].stage==='negotiating')&&db.pipe.c1.stage==='replied'&&db.pipe.c2.stage==='address_needed'"),'intent → stage for each: negotiate, question, interested');
   ok(t.E("inboxCfg().replies.every(r=>r.intent===undefined||r.intent===''||['INTERESTED','QUESTION','NEGOTIATE','DECLINE','OUT_OF_OFFICE','OTHER'].includes(r.intent))"),'intents always from the fixed list');
   const req=t.srv.anth.calls.find(c=>c.body.tool_choice);
   ok(req.body.tool_choice.name==='classify_replies'&&/stage now "contacted"/.test(req.body.messages[0].content),'forced tool output, creator stage given as context');
   t.close()}

  {const t=boot(FULL,seed());await wait(40);await settle(t);t.srv.anth.scripts.ops=[];
   t.E(`inboxCfg().replies.push({gmId:'x1',creatorId:'a',name:'Ana',email:'ana@x.co',subject:'Re',at:new Date().toISOString(),status:'new',body:'hmm maybe, not sure'},
     {gmId:'x2',creatorId:'n',name:'Nora',email:'nora@q.co',subject:'Re',at:new Date().toISOString(),status:'new',body:'Count me in'})`);
   t.srv.anth.skipIds=['x2'];let first=true;
   const cc0=t.srv.anth.classifyCalls||0;
   await t.E("triageAllNew()");await settle(t);
   ok(t.E("findReply('x2').intent")==='OTHER'&&t.E("findReply('x2').needsReview")===true,'a reply the model skipped (even after one retry) is marked for review, never guessed');
   ok((t.srv.anth.classifyCalls-cc0)===2,'skipped reply retried once on its own');
   ok(t.E("findReply('x1').needsReview")===true&&t.E("db.pipe.a.stage")==='replied','low confidence → review, stage only moves to "replied"');
   ok(t.E("db.ai.approvals.some(x=>x.kind==='todo:review-x1')"),'low-confidence reply lands on your to-do list');
   ok(t.E("OPS_TOOLS.send_reply.run({reply_id:'x1'})").then!==undefined,'send_reply callable');
   const q=await t.E("(async()=>{const r=findReply('x1');r.intent='OUT_OF_OFFICE';r.aiDraft='ok';db.ai.auto.on=true;return JSON.stringify(await OPS_TOOLS.send_reply.run({reply_id:'x1'}))})()");
   ok(JSON.parse(q).queued_for_approval,'a reply under review is never auto-sent');
   t.close()}

  out.push('stages never go backwards by accident');
  {const t=boot(FULL,seed());await wait(40);await settle(t);t.srv.anth.scripts.ops=[];
   t.E(`db.pipe.s={id:'s',name:'Sol',email:'sol@x.co',stage:'live_ok',shippedAt:new Date().toISOString(),videoUrl:'https://youtu.be/x',addr:{line1:'1',city:'P',country:'FR'},log:[]};
     inboxCfg().replies.push({gmId:'y1',creatorId:'s',name:'Sol',email:'sol@x.co',subject:'Re',at:new Date().toISOString(),status:'new',body:'Any update on when I get paid?'},
       {gmId:'y2',creatorId:'s',name:'Sol',email:'sol@x.co',subject:'Re',at:new Date().toISOString(),status:'new',body:'no thanks, not interested anymore'})`);
   await t.E("triageAllNew()");await settle(t);
   ok(t.E("db.pipe.s.stage")==='live_ok','a live creator asking a question stays live (was reset to "replied" before)');
   ok(t.E("db.ai.approvals.some(x=>x.kind==='todo:decline-after-ship'&&x.priority==='high')"),'"no thanks" after shipping → your decision, not an auto-decline');
   const r=JSON.parse(t.E("JSON.stringify(OPS_TOOLS.set_stage.run({id:'s',stage:'contacted',reason:'x'}))"));
   ok(r.error&&/allow_backward/.test(r.error),'agent cannot move a creator back without saying why');
   t.close()}

  out.push('deliveries');
  {const t=boot(FULL,seed());await wait(40);await settle(t);t.srv.anth.scripts.ops=[];
   const iso2=d=>new Date(Date.now()-d*86400000).toISOString();
   t.E(`db.pipe.d1={id:'d1',name:'D1',email:'d1@x.co',stage:'shipped',shippedAt:'${iso2(3)}',addr:{line1:'1',city:'P',country:'FR'},log:[]};
     db.pipe.d2={id:'d2',name:'D2',email:'d2@x.co',stage:'shipped',shippedAt:'${iso2(4)}',addr:{line1:'1',city:'P',country:'FR'},log:[]};
     db.pipe.d3={id:'d3',name:'D3',email:'d3@x.co',stage:'shipped',shippedAt:'${iso2(12)}',addr:{line1:'1',city:'P',country:'FR'},log:[]};
     inboxCfg().replies.push({gmId:'z1',creatorId:'d1',name:'D1',email:'d1@x.co',subject:'Re',at:new Date().toISOString(),status:'new',body:'Got the box yesterday, it arrived fine, filming this week https://youtu.be/abcdefghijk'},
       {gmId:'z2',creatorId:'d2',name:'D2',email:'d2@x.co',subject:'Re',at:new Date().toISOString(),status:'new',body:'The package arrived damaged, the jar is broken'})`);
   await t.E("triageAllNew()");await settle(t);
   ok(t.E("db.pipe.d1.ship.status")==='delivered'&&!!t.E("db.pipe.d1.ship.deliveredAt"),'"got the box" in a reply → parcel marked delivered, with the quote as evidence');
   ok(t.E("db.pipe.d1.videoUrl")==='https://youtu.be/abcdefghijk'&&t.E("db.pipe.d1.stage")==='live_pending','video link in the same reply → logged, stage moves to waiting for the video');
   ok(t.E("db.pipe.d2.ship.status")==='issue'&&t.E("db.ai.approvals.some(x=>x.kind==='todo:delivery'&&x.priority==='high')"),'"arrived damaged" → delivery issue + high-priority to-do');
   const sh=JSON.parse(t.E("JSON.stringify(OPS_TOOLS.get_shipments.run({}))"));
   ok(sh.total===3&&sh.overdue_in_transit===1&&sh.overdue[0].id==='d3'&&sh.issues===1,'get_shipments: counts, overdue parcel found ('+JSON.stringify(sh.by_status)+')');
   t.E("db.ai.auto.on=true;db.ai.flags={}");t.srv.anth.scripts.ops=[()=>say('ok')];
   const n=t.E("aiScan(true)");await settle(t);
   ok(t.E("db.ai.flags.d3&&!!db.ai.flags.d3.shipCheck")&&!t.E("db.ai.flags.d2&&db.ai.flags.d2.shipCheck"),'scan asks about the parcel 12 days in transit, not the one with an open issue');
   t.E("window.prompt=(q)=>/Tracking/.test(q)?'1Z999AA10123456784':'UPS'");
   t.E(`db.pipe.e1={id:'e1',name:'E1',email:'e1@x.co',stage:'address_ready',addr:{line1:'1',city:'P',country:'FR'},log:[]};markShipped('e1')`);
   ok(t.E("db.pipe.e1.ship.tracking")==='1Z999AA10123456784'&&t.E("trackingUrl(db.pipe.e1.ship)").includes('ups.com'),'shipping asks for tracking + carrier, builds the tracking link');
   t.close()}

  out.push('supervisor + data audit');
  {const t=boot(FULL,seed());await wait(40);await settle(t);
   t.E(`db.pipe.bad1={id:'bad1',name:'B',email:'ana@x.co',stage:'address_ready',log:[]};db.pipe.bad2={id:'bad2',name:'B2',email:'b2@x.co',stage:'live_pending',shippedAt:new Date().toISOString(),log:[]}`);
   const au=JSON.parse(t.E("JSON.stringify(OPS_TOOLS.audit_data.run({}))"));
   const has=k=>au.issues.some(i=>i.check===k);
   ok(has('ready_to_ship_without_address')&&has('live_without_video_link')&&has('duplicate_email'),'audit finds contradictions and duplicates ('+au.issues.map(i=>i.check).join(', ')+')');
   let prompt='';
   t.srv.anth.scripts.ops=[b=>{prompt=b.messages[0].content;return tool('record_insight',{title:'Daily brief',detail:'x',category:'general'},'i')},()=>say('done')];
   ok(t.E("aiSupervise(true)")===true,'supervisor starts');await settle(t);
   ok(/DATA AUDIT/.test(prompt)&&/duplicate_email/.test(prompt)&&/DELIVERIES/.test(prompt),'supervisor hands Sonnet the exact audit, deliveries and metrics');
   ok(t.E("db.ai.insights.some(i=>i.title==='Daily brief')"),'daily brief recorded');
   ok(t.E("aiSupervise()")===false,'runs once a day unless forced');
   t.close()}

  out.push('conversation memory');
  {const t=boot(FULL,seed());await wait(40);await settle(t);
   t.E("db.ai.chat=[];for(let i=0;i<30;i++){db.ai.chat.push({role:'user',text:'q'+i},{role:'assistant',text:'a'+i,acts:i===29?'set_stage':''})}");
   let hist=null;
   t.srv.anth.scripts.ops=[b=>{hist=b.messages;return say('Réponse.')}];
   await t.E("aiAsk('Et maintenant ?')");await settle(t);
   ok(hist&&hist.length>=24&&hist[hist.length-1].content==='Et maintenant ?','the last 24 turns go to the model, not 8 ('+(hist&&hist.length)+')');
   ok(hist.some(m=>typeof m.content==='string'&&m.content.includes('[actions taken: set_stage]')),'the model sees what it did on earlier turns');
   await wait(50);
   ok(t.E("db.ai.chat.length")<=41,'old turns folded away');
   t.close()}

  out.push('scale');
  {const t=boot(FULL,seed());await wait(40);await settle(t);
   t.E(`db.pipe={};db.out.sent=[];const now=Date.now();for(let i=0;i<20000;i++){db.pipe['p'+i]={id:'p'+i,name:'P'+i,email:'p'+i+'@x.co',stage:'contacted',log:[{at:new Date(now).toISOString(),msg:'x'}]};
     db.out.sent.push({id:'p'+i,at:new Date(now-86400000).toISOString(),ok:true})}db.ai.auto.on=true;db.ai.flags={}`);
   const ms=t.E("(()=>{const t0=Date.now();aiScan(true);return Date.now()-t0})()");
   ok(ms<1500,'scan over 20,000 creators in '+ms+' ms (was quadratic)');
   const ms2=t.E("(()=>{const t0=Date.now();CadenceAnalytics.audit(analyticsCtx());return Date.now()-t0})()");
   ok(ms2<1500,'full data audit over 20,000 creators in '+ms2+' ms');
   t.E("aiJobs.length=0");t.close()}

  console.log(out.join('\n'));console.log(`\n${pass} passed, ${fail} failed`);process.exit(fail?1:0)
})().catch(e=>{console.error(e);process.exit(1)});
