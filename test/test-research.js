// /api/research — job queue, worker lease/checkpoint protocol, results paging, budgets.
// node test/test-research.js
const {setup,FULL}=require('./harness');
let pass=0,fail=0;const out=[];
const ok=(c,m)=>{if(c){pass++;out.push('  ✓ '+m)}else{fail++;out.push('  ✗ '+m)}};
const W={'x-worker-secret':'wsec'};
const ENV={...FULL,FREE_HARVEST_SECRET:'wsec'};
const brief={title:'Teveo — natural bodybuilding',niche_summary:'Women and men doing bodybuilding/gym training',target_count:300};

(async()=>{
  out.push('browser side');
  {const t=setup(ENV);
   const bad=await t.call('research',{method:'POST',query:{op:'create'},body:{brief:{}}});
   ok(bad.status===400,'a brief without a niche is refused');
   const r=await t.call('research',{method:'POST',query:{op:'create'},body:{brief}});
   ok(r.status===200&&/^rs/.test(r.json.id),'job created ('+r.json.id+')');
   ok(r.json.instant===false,'no GH token → no instant dispatch, the scheduled worker picks it up');
   const jobs=await t.call('research',{query:{op:'jobs'}});
   ok(jobs.json.jobs.length===1&&jobs.json.jobs[0].status==='queued'&&jobs.json.jobs[0].title.startsWith('Teveo'),'listed as queued');
   const j=await t.call('research',{query:{op:'job',id:r.json.id}});
   ok(j.json.job.target===300&&j.json.job.resultsCount===0,'target from brief, no results yet');}
  {const t=setup({...ENV,CADENCE_ACCESS_CODE:'x'});
   const r=await t.call('research',{query:{op:'jobs'}});
   ok(r.status===401,'browser ops behind the access code');}

  out.push('worker protocol');
  {const t=setup(ENV);
   const noAuth=await t.call('research',{method:'POST',query:{op:'claim'},body:{}});
   ok(noAuth.status===401,'worker ops need the worker secret');
   const peek0=await t.call('research',{method:'POST',headers:W,query:{op:'peek'},body:{}});
   ok(peek0.json.work===false,'peek: nothing to do');
   const c1=await t.call('research',{method:'POST',query:{op:'create'},body:{brief}});
   const c2=await t.call('research',{method:'POST',query:{op:'create'},body:{brief:{...brief,title:'second'}}});
   const peek=await t.call('research',{method:'POST',headers:W,query:{op:'peek'},body:{}});
   ok(peek.json.work===true,'peek: work waiting');
   const cl=await t.call('research',{method:'POST',headers:W,query:{op:'claim'},body:{runner:'gh-1'}});
   ok(cl.json.job&&cl.json.job.id===c1.json.id,'oldest job claimed first');
   ok(cl.json.job.status==='running'&&cl.json.ckpt===null,'running, no checkpoint yet');
   const cl2=await t.call('research',{method:'POST',headers:W,query:{op:'claim'},body:{runner:'gh-2'}});
   ok(cl2.json.job&&cl2.json.job.id===c2.json.id,'a running (leased) job is not claimed twice');
   const sv=await t.call('research',{method:'POST',headers:W,query:{op:'save'},body:{id:c1.json.id,patch:{stats:{accepted:3},phase:'harvest'},ckpt:{seen:{a:1}},log:['harvested #gymtok']}});
   ok(sv.json.status==='running','save keeps it running');
   const add=await t.call('research',{method:'POST',headers:W,query:{op:'add'},body:{id:c1.json.id,creators:[{handle:'A',score:90},{handle:'b',score:80}]}});
   ok(add.json.added===2,'two creators added');
   const add2=await t.call('research',{method:'POST',headers:W,query:{op:'add'},body:{id:c1.json.id,creators:[{handle:'a',score:95}]}});
   ok(add2.json.added===0,'re-adding a creator updates, never duplicates');
   const res=await t.call('research',{query:{op:'results',id:c1.json.id,offset:'0',limit:'10'}});
   ok(res.json.total===2&&res.json.items[0].score===95,'results paged, updated in place');
   const job=await t.call('research',{query:{op:'job',id:c1.json.id}});
   ok(job.json.job.stats.accepted===3&&job.json.job.log[0].m==='harvested #gymtok'&&job.json.job.resultsCount===2,'progress + log visible to the app');
   // stop request wins
   await t.call('research',{method:'POST',query:{op:'cancel'},body:{id:c1.json.id}});
   const sv2=await t.call('research',{method:'POST',headers:W,query:{op:'save'},body:{id:c1.json.id,patch:{status:'running'}}});
   ok(sv2.json.status==='cancel_requested','worker sees the stop request on its next save');
   await t.call('research',{method:'POST',headers:W,query:{op:'save'},body:{id:c1.json.id,patch:{status:'cancelled'}}});
   // resume
   const rs=await t.call('research',{method:'POST',query:{op:'resume'},body:{id:c1.json.id,addTarget:200}});
   ok(rs.json.status==='queued','resume requeues');
   const cl3=await t.call('research',{method:'POST',headers:W,query:{op:'claim'},body:{runner:'gh-3'}});
   ok(cl3.json.job.id===c1.json.id&&cl3.json.ckpt&&cl3.json.ckpt.seen.a===1&&cl3.json.job.target===500,'resumed with its checkpoint and a larger target');
   ok(cl3.json.job.runs===2,'session counter increments');}
  {const t=setup(ENV);
   const c=await t.call('research',{method:'POST',query:{op:'create'},body:{brief}});
   await t.call('research',{method:'POST',headers:W,query:{op:'claim'},body:{}});
   // simulate a dead worker: lease expired
   const key='cadence:rs:job:'+c.json.id;const j=JSON.parse(t.redis.store.get(key));j.leaseUntil=Date.now()-1;t.redis.store.set(key,JSON.stringify(j));
   const again=await t.call('research',{method:'POST',headers:W,query:{op:'claim'},body:{}});
   ok(again.json.job&&again.json.job.id===c.json.id,'an expired lease is reclaimed — a crashed run never strands a job');}

  out.push('AI proxy on its own budget');
  {const t=setup({...ENV,RESEARCH_TOKEN_CAP:'1000'});
   const r=await t.call('research',{method:'POST',headers:W,query:{op:'ai'},body:{payload:{tier:'haiku',max_tokens:100,messages:[{role:'user',content:'hi'}]}}});
   ok(r.status===200,'worker AI call goes through');
   const call=t.anth.calls[0].body;
   ok(call.model==='claude-haiku-4-5-20251001','tier haiku mapped server-side');
   ok(t.redis.store.get('cadence:rsusage:'+new Date().toISOString().slice(0,10))==='150','metered under rsusage, not the app budget');
   ok(!t.redis.store.get('cadence:usage:'+new Date().toISOString().slice(0,10)),'app budget untouched');
   t.redis.store.set('cadence:rsusage:'+new Date().toISOString().slice(0,10),'5000');
   const r2=await t.call('research',{method:'POST',headers:W,query:{op:'ai'},body:{payload:{messages:[{role:'user',content:'hi'}]}}});
   ok(r2.status===429,'research cap enforced');}

  console.log(out.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  if(fail)process.exit(1);
})();
