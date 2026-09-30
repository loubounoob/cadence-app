// /api/research — job queue, multi-machine shards, shared sources + dedupe, creator base, budgets.
// node test/test-research.js
const {setup,FULL}=require('./harness');
let pass=0,fail=0;const out=[];
const ok=(c,m)=>{if(c){pass++;out.push('  ✓ '+m)}else{fail++;out.push('  ✗ '+m)}};
const W={'x-worker-secret':'wsec'};
const ENV={...FULL,FREE_HARVEST_SECRET:'wsec'};
const brief={title:'Teveo — natural bodybuilding',niche_summary:'Women and men doing bodybuilding/gym training',target_count:300};
const wk=(t,op,body)=>t.call('research',{method:'POST',headers:W,query:{op},body:body||{}});

(async()=>{
  out.push('browser side');
  {const t=setup(ENV);
   const bad=await t.call('research',{method:'POST',query:{op:'create'},body:{brief:{}}});
   ok(bad.status===400,'a brief without a niche is refused');
   const r=await t.call('research',{method:'POST',query:{op:'create'},body:{brief}});
   ok(r.status===200&&/^rs/.test(r.json.id)&&r.json.machines===4,'job created, split for 4 machines ('+r.json.machines+')');
   ok(r.json.instant===false,'no GH token → the scheduled workers pick it up');
   const small=await t.call('research',{method:'POST',query:{op:'create'},body:{brief:{...brief,target_count:20}}});
   ok(small.json.machines===1,'a tiny search runs on one machine');
   const jobs=await t.call('research',{query:{op:'jobs'}});
   ok(jobs.json.jobs.length===2&&jobs.json.jobs.every(j=>j.status==='queued'),'listed as queued');}
  {const t=setup({...ENV,CADENCE_ACCESS_CODE:'x'});
   ok((await t.call('research',{query:{op:'jobs'}})).status===401,'browser ops behind the access code');}

  out.push('several machines on one job');
  {const t=setup(ENV);
   ok((await t.call('research',{method:'POST',query:{op:'claim'},body:{}})).status===401,'worker ops need the worker secret');
   const c=await t.call('research',{method:'POST',query:{op:'create'},body:{brief}});const id=c.json.id;
   const pk=await wk(t,'peek');ok(pk.json.shards===4,'peek: 4 shards claimable');
   const m=[];for(let i=0;i<4;i++)m.push((await wk(t,'claim',{runner:'r'+i})).json);
   ok(m.map(x=>x.shard).join()==='0,1,2,3','each machine leases a different shard');
   ok(m.filter(x=>x.planner).length===1,'exactly one machine plans');
   ok((await wk(t,'claim',{})).json.job===null,'a 5th machine finds nothing to do');
   // shared source queue
   const add=await wk(t,'src-add',{id,items:[{key:'t:gymtok',pri:80},{key:'k:programme musculation',pri:70},{key:'t:legday',pri:40},{key:'bad',pri:99}]});
   ok(add.json.added===3,'sources queued (malformed key refused)');
   ok((await wk(t,'src-add',{id,items:[{key:'t:gymtok',pri:99}]})).json.added===0,'a source is only ever queued once across all machines');
   const n1=await wk(t,'src-next',{id,n:2}),n2=await wk(t,'src-next',{id,n:2});
   ok(n1.json.items.map(x=>x.key).join()==='t:gymtok,k:programme musculation'&&n2.json.items.map(x=>x.key).join()==='t:legday','machines pop the best sources first, never the same one twice');
   // shared dedupe
   const a=await wk(t,'mark',{id,handles:['Alice','bob']}),b=await wk(t,'mark',{id,handles:['alice','carl']});
   ok(a.json.fresh.join()==='alice,bob'&&b.json.fresh.join()==='carl','a creator is read by one machine only');
   // progress rolls up
   await wk(t,'save',{id,shard:0,patch:{stats:{authorsSeen:100,costUsd:0.5,queue:{triage:3}},shardStatus:'running',plan:{disq:['shop'],persona:'p',keywords:['programme musculation']}},log:['planned']});
   const s1=await wk(t,'save',{id,shard:1,patch:{stats:{authorsSeen:50,costUsd:0.25}},log:['#legday']});
   ok(s1.json.planned&&s1.json.disq[0]==='shop'&&s1.json.keywords[0]==='programme musculation','other machines receive the plan');
   ok(s1.json.costUsd===0.75,'cost summed across machines');
   const job=(await t.call('research',{query:{op:'job',id}})).json.job;
   ok(job.stats.authorsSeen===150&&job.stats.machines===4&&job.log.some(l=>l.m==='[2] #legday'),'job totals and per-machine log in the app');
   // results + global target
   const r1=await wk(t,'add',{id,creators:[{handle:'A',score:90},{handle:'b',score:80}]});
   const r2=await wk(t,'add',{id,creators:[{handle:'a',score:95}]});
   ok(r1.json.accepted===2&&r2.json.added===0&&r2.json.accepted===2,'job-wide accepted count, no duplicates');
   const res=await t.call('research',{query:{op:'results',id,offset:'0',limit:'10'}});
   ok(res.json.total===2&&res.json.items[0].score===95,'results paged, updated in place');
   // finishing: all shards done → job done
   for(const k of [0,1,2])await wk(t,'save',{id,shard:k,patch:{shardStatus:'done',stopWhy:'Target reached'}});
   ok((await t.call('research',{query:{op:'job',id}})).json.job.status==='running','still running while one machine works');
   const last=await wk(t,'save',{id,shard:3,patch:{shardStatus:'done'}});
   ok(last.json.allDone&&last.json.status==='done','done once every machine is done');
   // resume + cancel
   const rs=await t.call('research',{method:'POST',query:{op:'resume'},body:{id,addTarget:200,addBudget:10}});
   ok(rs.json.status==='queued','resume requeues every machine');
   const cl=await wk(t,'claim',{});ok(cl.json.job&&cl.json.job.target===500&&!cl.json.planner,'resumed with a larger target, no re-planning');
   await t.call('research',{method:'POST',query:{op:'cancel'},body:{id}});
   ok((await wk(t,'save',{id,shard:cl.json.shard,patch:{shardStatus:'running'}})).json.status==='cancel_requested','machines see the stop request');}
  {const t=setup(ENV);
   const c=await t.call('research',{method:'POST',query:{op:'create'},body:{brief:{...brief,target_count:20}}});
   await wk(t,'claim',{});
   const key='cadence:rs:job:'+c.json.id;const j=JSON.parse(t.redis.store.get(key));j.shard[0].leaseUntil=Date.now()-1;t.redis.store.set(key,JSON.stringify(j));
   ok((await wk(t,'claim',{})).json.job.id===c.json.id,'an expired lease is reclaimed — a crashed machine never strands a job');}
  {const t=setup(ENV); // job created by the previous single-machine build
   const id='rsold';t.redis.store.set('cadence:rs:job:rsold',JSON.stringify({id,status:'queued',target:50,brief,log:[]}));
   t.redis.store.set('cadence:rs:jobs',[id]);t.redis.store.set('cadence:rs:ck:rsold',JSON.stringify({v:1,seen:{x:'a'}}));
   const cl=await wk(t,'claim',{});
   ok(cl.json.job&&cl.json.shard===0&&cl.json.ckpt&&cl.json.ckpt.v===1,'older single-machine jobs still resume with their checkpoint');}

  out.push('creator base');
  {const t=setup(ENV);
   await wk(t,'pool-put',{creators:[{h:'alice',f:20000,b:'coach',c:['a','b','c'],m:{med:5000},q:'full'}]});
   await wk(t,'pool-put',{creators:[{h:'alice',f:21000,c:['x'],q:'lite'},{h:'bob',f:9000,q:'lite'}]});
   await wk(t,'pool-put',{creators:[{h:'alice',ni:'powerlifting',sf:'clean',fl:[]}]});
   const sc=await wk(t,'pool-scan',{cursor:'0',count:100});
   const al=sc.json.items.find(x=>x.h==='alice');
   ok(sc.json.items.length===2,'every creator kept once');
   ok(al.f===21000&&al.c.length===3&&al.m.med===5000&&al.ni==='powerlifting','a lite update never erases what a full read learned');
   ok((await t.call('research',{query:{op:'pool'}})).json.creators===2,'base size visible to the app');}

  out.push('AI proxy on its own budget');
  {const t=setup({...ENV,RESEARCH_TOKEN_CAP:'1000'});
   const r=await wk(t,'ai',{payload:{tier:'haiku',max_tokens:100,messages:[{role:'user',content:'hi'}]}});
   ok(r.status===200&&t.anth.calls[0].body.model==='claude-haiku-4-5-20251001','worker AI call, tier mapped server-side');
   const day=new Date().toISOString().slice(0,10);
   ok(t.redis.store.get('cadence:rsusage:'+day)==='150'&&!t.redis.store.get('cadence:usage:'+day),'metered on the research budget, app budget untouched');
   t.redis.store.set('cadence:rsusage:'+day,'5000');
   ok((await wk(t,'ai',{payload:{messages:[{role:'user',content:'hi'}]}})).status===429,'research cap enforced');}

  console.log(out.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  if(fail)process.exit(1);
})();
