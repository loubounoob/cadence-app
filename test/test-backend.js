// Backend tests: node test/test-backend.js
const {setup,tool,say,toolResult,FULL}=require('./harness');
let pass=0,fail=0;const out=[];
const ok=(c,m)=>{if(c){pass++;out.push('  ✓ '+m)}else{fail++;out.push('  ✗ '+m)}};
const iso=d=>new Date(Date.now()-d*86400000).toISOString();

(async()=>{
  out.push('health');
  {const t=setup({});const r=await t.call('health');
   ok(r.status===200&&r.json.key===false&&r.json.storage===false&&r.json.model==='claude-sonnet-5','reports missing key and storage honestly');
   const t2=setup(FULL);const r2=await t2.call('health');
   ok(r2.json.key===true&&r2.json.storage===true,'reports key and storage when configured');
   ok(!r2.raw.includes('SECRET')&&!r2.raw.includes('redis-token'),'never returns a secret')}

  out.push('ai proxy');
  {const t=setup({});const r=await t.call('ai',{method:'POST',body:{messages:[{role:'user',content:'hi'}]}});
   ok(r.status===503&&r.json.error.type==='no_key','no key → 503 no_key, nothing sent upstream');
   ok(t.anth.calls.length===0,'Anthropic not called without a key')}
  {const t=setup(FULL);
   const r=await t.call('ai',{method:'POST',body:{model:'claude-opus-4-1',metadata:{x:1},max_tokens:99999,system:'s',messages:[{role:'user',content:'hi'}],tools:[]}});
   const up=t.anth.calls[0];
   ok(r.status===200&&up.body.model==='claude-sonnet-5','model forced to claude-sonnet-5 even when the page asks for another');
   ok(up.body.max_tokens===4096&&up.body.metadata===undefined,'unknown fields dropped, max_tokens clamped to 4096');
   ok(up.headers['x-api-key']==='sk-ant-SECRET-test-key'&&!r.raw.includes('SECRET'),'key added server-side, never echoed back');
   const used=Number(t.redis.store.get('cadence:usage:'+new Date().toISOString().slice(0,10)));
   ok(used===150,'token usage metered per day in Redis ('+used+')');
   t.anth.failNext=1;const r2=await t.call('ai',{method:'POST',body:{messages:[{role:'user',content:'x'}]}});
   ok(r2.status===529,'upstream overload passed through (client retries)');
   const bad=await t.call('ai',{method:'POST',body:{}});ok(bad.status===400,'empty messages rejected');
   const g=await t.call('ai',{method:'GET'});ok(g.status===405,'GET refused')}
  {const t=setup({...FULL,DAILY_TOKEN_CAP:'100'});
   await t.call('ai',{method:'POST',body:{messages:[{role:'user',content:'x'}]}});
   const r=await t.call('ai',{method:'POST',body:{messages:[{role:'user',content:'x'}]}});
   ok(r.status===429&&r.json.error.type==='daily_cap'&&t.anth.calls.length===1,'daily token cap stops spending once reached')}
  {const t=setup({...FULL,CADENCE_ACCESS_CODE:'lille59'});
   const r=await t.call('ai',{method:'POST',body:{messages:[{role:'user',content:'x'}]}});
   const r2=await t.call('ai',{method:'POST',headers:{'x-cadence-code':'lille59'},body:{messages:[{role:'user',content:'x'}]}});
   ok(r.status===401&&r2.status===200,'optional access code enforced when set')}

  out.push('sync');
  {const t=setup({ANTHROPIC_API_KEY:'k'});const r=await t.call('sync',{method:'POST',body:{}});
   ok(r.json.storage===false&&r.json.ops.length===0,'no Redis → storage:false, app keeps working locally')}
  {const t=setup(FULL);
   const r=await t.call('sync',{method:'POST',body:{records:{pipe:{a:{id:'a',stage:'contacted'},b:{id:'b',stage:'replied'}},evil:{x:{}}},
     events:[{id:'e1',type:'email_sent'},{id:'e2',type:'stage_changed'}],meta:{out:{rate:5}}}});
   const pipe=t.redis.store.get('cadence:rec:pipe');
   ok(r.json.storage===true&&pipe.size===2&&!t.redis.store.has('cadence:rec:evil'),'records stored per collection, unknown collections ignored');
   ok(JSON.parse(t.redis.store.get('cadence:events')[0]).id==='e1','events keep the app order (newest first)');
   await t.call('sync',{method:'POST',body:{removed:{pipe:['b']}}});
   ok(t.redis.store.get('cadence:rec:pipe').size===1,'removed records deleted');
   const big={};for(let i=0;i<900;i++)big['c'+i]={id:'c'+i,pad:'x'.repeat(1500)};
   await t.call('sync',{method:'POST',body:{records:{pipe:big}}});
   const hsets=t.redis.cmds.filter(c=>c[0]==='HSET'&&c[1]==='cadence:rec:pipe').length;
   ok(t.redis.store.get('cadence:rec:pipe').size===901&&hsets>=3,`large pushes split into ${hsets} Redis commands under the size limit`);
   const evs=[];for(let i=0;i<2100;i++)evs.push({id:'x'+i});
   for(let i=0;i<8;i++)await t.call('sync',{method:'POST',body:{events:evs.slice(i*300,i*300+300)}});
   ok(t.redis.store.get('cadence:events').length===2000,'event log capped at 2,000');
   t.redis.store.set('cadence:ops',new Map([['o1',JSON.stringify({id:'o1',at:'2026-01-01',type:'log',msg:'hi'})]]));
   const r3=await t.call('sync',{method:'POST',body:{}});
   ok(r3.json.ops.length===1&&r3.json.ops[0].id==='o1','pending server ops returned to the app');
   const r4=await t.call('sync',{method:'POST',body:{ack:['o1']}});
   ok(r4.json.ops.length===0,'acknowledged ops removed')}

  out.push('server agent');
  {const t=setup({ANTHROPIC_API_KEY:'k'});const r=await t.call('agent',{method:'POST',body:{}});
   ok(r.status===503&&r.json.error.type==='no_storage','no Redis → explains that it needs server memory')}
  {const t=setup(FULL);const r=await t.call('agent',{method:'POST',body:{}});
   ok(r.status===200&&r.json.skipped,'nothing synced yet → skips without calling the model');
   ok(t.anth.calls.length===0,'no model call wasted')}
  {const t=setup(FULL);
   const pipe={
     a:{id:'a',name:'Ana',email:'ana@x.co',stage:'contacted',log:[{at:iso(8),msg:'First email sent'}]},
     b:{id:'b',name:'Ben',email:'ben@x.co',stage:'contacted',log:[{at:iso(1),msg:'First email sent'}]},
     s:{id:'s',name:'Sol',email:'sol@x.co',stage:'shipped',shippedAt:iso(20),videoUrl:'',log:[{at:iso(20),msg:'Marked as shipped'}]},
     g:{id:'g',name:'Gus',email:'gus@x.co',stage:'negotiating',log:[{at:iso(4),msg:'Replied — negotiating'}]},
     d:{id:'d',name:'Dee',email:'dee@x.co',stage:'contacted',log:[{at:iso(9),msg:'First email sent'}]}};
   const sent={a:{id:'a',ok:true,at:iso(8),gmThreadId:'tA'},b:{id:'b',ok:true,at:iso(1)},d:{id:'d',ok:true,at:iso(9)}};
   const camp={c1:{id:'c1',name:'Mood',budget:10000,spent:0,owed:9000,views:1800000,budget_used_pct:90}};
   await t.call('sync',{method:'POST',body:{records:{pipe,sent,camp},
     meta:{out:{rate:5,fromName:'Louis Bouyer',subject:'An idea'},auto:{on:true,followUpDays:5,remindDays:14,budgetAlert:0.85},
       flags:{d:{followUp:Date.now()}}},events:[{id:'e1',at:new Date().toISOString(),type:'email_sent',cat:'outreach',data:{count:12}}]}});
   t.anth.scripts.server=[
     b=>{const txt=b.messages[0].content;return tool('get_metrics',{},'m1')},
     b=>tool('propose_email',{creator_id:'a',kind:'follow_up',body:'Quick follow-up — still $5 per 1,000 views. Worth a look?',reason:'8 days silent'},'p1'),
     b=>tool('propose_email',{creator_id:'s',kind:'video_reminder',body:'Did the box arrive? When do you plan to post?',reason:'20 days, no video'},'p2'),
     b=>tool('propose_email',{creator_id:'g',kind:'counter_offer',body:'We can go to $9 per 1,000 views.',reason:'x'},'p3'),
     b=>{const r=toolResult(b,'p3');return tool('flag_for_human',{creator_id:'g',reason:'Gus wants more — hold at $5/1k'+(r.error?'':' BUG'),priority:'normal'},'f1')},
     b=>tool('flag_for_human',{reason:'Campaign Mood at 90% — pause new outreach',priority:'high'},'f2'),
     b=>tool('record_insight',{title:'Daily brief',detail:'12 sent today, 90% budget used',category:'general',priority:'normal'},'i1'),
     ()=>say('Handled 4 situations.')];
   const r=await t.call('agent',{method:'POST',body:{source:'manual'}});
   const first=t.anth.calls[0].body.messages[0].content;
   ok(r.status===200&&r.json.situations===5,`scan found 5 situations (follow-up Ana, delivery check + reminder Sol, stuck Gus, budget) — got ${r.json.situations}`);
   ok(!/creator_id=b\b/.test(first)&&!/creator_id=d\b/.test(first),'recent contact (Ben) and already-followed-up (Dee, flag from the app) are left alone');
   ok(t.anth.calls.every(c=>c.body.model==='claude-sonnet-5'),'server agent uses Sonnet only');
   const ops=Object.values(Object.fromEntries([...t.redis.store.get('cadence:ops')].map(([k,v])=>[k,JSON.parse(v)])));
   const ap=ops.filter(o=>o.type==='approval').map(o=>o.item.type+':'+o.item.kind);
   ok(ap.includes('email:follow_up')&&ap.includes('email:video_reminder'),'follow-up and reminder filed as approvals, not sent');
   ok(!ap.includes('email:counter_offer'),'counter-offer above the ceiling refused by the tool');
   ok(ops.some(o=>o.type==='insight'&&o.item.title==='Daily brief'),'daily brief recorded as an insight');
   ok(ops.some(o=>o.type==='flags'&&o.flags.a&&o.flags.a.followUp),'flags op sent back so the app will not repeat the follow-up');
   ok(ops.some(o=>o.type==='log'),'run summary logged for the app');
   const health=await t.call('health');ok(health.json.last_agent_run&&health.json.last_agent_run.ops>=4,'last run visible in /api/health');
   // second run: nothing new
   t.anth.scripts.server=[()=>tool('record_insight',{title:'Daily brief',category:'general'},'i2'),()=>say('Quiet.')];
   const r2=await t.call('agent',{method:'POST',body:{}});
   ok(r2.json.situations===0,'second run does not re-trigger the same situations');
   // lock
   t.redis.store.set('cadence:agent:lock','1');
   const r3=await t.call('agent',{method:'POST',body:{}});ok(r3.status===409,'overlapping runs blocked by a lock');
   t.redis.store.delete('cadence:agent:lock');
   // pending ops overlay
   const st=await t.h('agent')._internal.loadState();
   ok(st.pipe.a.stage==='contacted','state loads');
   t.redis.store.get('cadence:ops').set('ov',JSON.stringify({id:'ov',type:'set_stage',id:'a',stage:'replied'}));
   const st2=await t.h('agent')._internal.loadState();
   ok(st2.pipe.a.stage==='replied','pending ops are overlaid so the agent sees the latest truth')}
  {const t=setup({...FULL,CRON_SECRET:'cs'});
   const r=await t.call('agent',{headers:{'user-agent':'vercel-cron/1.0'}});
   const r2=await t.call('agent',{headers:{'user-agent':'vercel-cron/1.0',authorization:'Bearer cs'}});
   ok(r.status===401&&r2.status===200,'cron route requires CRON_SECRET when it is set')}
  {const t=setup({...FULL,CADENCE_ACCESS_CODE:'z'});
   const r=await t.call('agent',{method:'POST',body:{}});ok(r.status===401,'manual agent run needs the access code when set')}

  console.log(out.join('\n'));console.log(`\n${pass} passed, ${fail} failed`);process.exit(fail?1:0)
})().catch(e=>{console.log(out.join('\n'));console.error('CRASH',e);process.exit(2)});
