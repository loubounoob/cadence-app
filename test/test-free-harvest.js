// Étage 1 (free collection) — the intake/pull endpoints and the TikTok item
// adapter. The Playwright harvester itself (harvest/free-harvest.mjs) talks
// to real TikTok pages and is integration-only; this tests everything on
// this side of that boundary: what happens to a row once it lands here.
// node test/test-free-harvest.js
const {setup,FULL}=require('./harness');
const {adaptItem}=require('../api/free-intake.js')._internal;
let pass=0,fail=0;const out=[];
const ok=(c,m)=>{if(c){pass++;out.push('  ✓ '+m)}else{fail++;out.push('  ✗ '+m)}};

// One real item shape, as seen live from www.tiktok.com/api/challenge/item_list
// (signed-out, no cookies beyond the anonymous ones the browser sets itself).
function fakeItem(over){
  return {
    desc:'my gym routine #gymtok',
    textLanguage:'en',
    createTime:1727600000,
    stats:{playCount:120000,diggCount:9000,commentCount:300,shareCount:80},
    author:{uniqueId:'fitgirl22',nickname:'Fit Girl',signature:'gym girl • home workouts',
      avatarLarger:'https://p.tiktokcdn.com/a.jpeg',verified:false,region:'US'},
    authorStats:{followerCount:42000,heart:900000,videoCount:210},
    ...over};
}

(async()=>{
  out.push('adaptItem — maps a real TikTok item into the app\'s existing Apify-shaped row');
  {const r=adaptItem(fakeItem(),'gymtok');
   ok(r.authorMeta.name==='fitgirl22','handle read from author.uniqueId');
   ok(r.authorMeta.fans===42000,'followers read from authorStats.followerCount');
   ok(r.authorMeta.signature==='gym girl • home workouts','bio carried through');
   ok(r.playCount===120000&&r.diggCount===9000&&r.commentCount===300,'video stats mapped');
   ok(r.createTimeISO==='2024-09-29T08:53:20.000Z','unix seconds → ISO');
   ok(r.searchHashtag.name==='gymtok','tagged with the hashtag it was harvested from');
   ok(r.src==='free','marked as a free-tier row');}
  {const r=adaptItem(fakeItem({author:{}}),'gymtok');
   ok(r===null,'an item with no handle is dropped, not passed through half-built');}
  {const r=adaptItem(fakeItem({isAd:true}),'gymtok');
   ok(r.isSponsored===true,'ad flag read from isAd');}
  {ok(adaptItem(null,'x')===null&&adaptItem(undefined,'x')===null,'garbage input never throws');}

  out.push('free-intake — auth, validation, queueing');
  {const t=setup({...FULL,FREE_HARVEST_SECRET:'s3cr3t'});
   const r=await t.call('free-intake',{method:'POST',body:{secret:'wrong',tag:'gymtok',items:[fakeItem()]}});
   ok(r.status===401,'wrong secret rejected');}
  {delete process.env.FREE_HARVEST_SECRET;const t=setup(FULL);
   const r=await t.call('free-intake',{method:'POST',body:{secret:'anything',tag:'gymtok',items:[fakeItem()]}});
   ok(r.status===503,'no FREE_HARVEST_SECRET configured on the server → refuses cleanly, not a silent no-op');}
  {const t=setup({...FULL,FREE_HARVEST_SECRET:'s3cr3t'});
   const r=await t.call('free-intake',{method:'POST',body:{secret:'s3cr3t',tag:'#GymTok!!',items:[fakeItem(),fakeItem({author:{uniqueId:'other1',followerCount:0},authorStats:{followerCount:5000}})]}});
   ok(r.status===200&&r.json.added===2,'valid rows queued, tag sanitised ('+JSON.stringify(r.json)+')');
   const key='cadence:free:gymtok';
   ok(t.redis.store.has(key),'queued under the sanitised tag key');
   ok(t.redis.store.get(key).length===2,'both rows stored');}
  {const t=setup({...FULL,FREE_HARVEST_SECRET:'s3cr3t'});
   const r=await t.call('free-intake',{method:'POST',body:{secret:'s3cr3t',tag:'',items:[fakeItem()]}});
   ok(r.status===400,'empty tag rejected');
   const r2=await t.call('free-intake',{method:'POST',body:{secret:'s3cr3t',tag:'x',items:[{garbage:1},null,fakeItem({author:{}})]}});
   ok(r2.status===200&&r2.json.added===0,'a batch of nothing-but-junk queues nothing, not an error');}
  {const t=setup({...FULL,FREE_HARVEST_SECRET:'s'});
   const many=Array.from({length:5000},(_,i)=>fakeItem({author:{uniqueId:'u'+i},authorStats:{followerCount:i}}));
   await t.call('free-intake',{method:'POST',body:{secret:'s',tag:'big',items:many.slice(0,500)}});
   await t.call('free-intake',{method:'POST',body:{secret:'s',tag:'big',items:many.slice(500,1000)}});
   const len=t.redis.store.get('cadence:free:big').length;
   ok(len<=4000,'queue capped even under repeated intake ('+len+')');}

  out.push('free-pull — the app draining what the harvester queued');
  {const t=setup(FULL);
   const r=await t.call('free-pull',{query:{tag:'gymtok'}});
   ok(r.status===200&&r.json.items.length===0&&r.json.more===false,'nothing queued → empty, not an error');}
  {const t=setup({...FULL,FREE_HARVEST_SECRET:'s'});
   await t.call('free-intake',{method:'POST',body:{secret:'s',tag:'gymtok',items:[fakeItem({author:{uniqueId:'a'}}),fakeItem({author:{uniqueId:'b'}}),fakeItem({author:{uniqueId:'c'}})]}});
   const r=await t.call('free-pull',{query:{tag:'gymtok',limit:'2'}});
   ok(r.json.items.length===2&&r.json.more===true,'partial pull leaves the rest queued, says so');
   ok(r.json.items[0].authorMeta&&typeof r.json.items[0].authorMeta.fans==='number','pulled rows are already app-shaped, ready for dxIngest');
   const r2=await t.call('free-pull',{query:{tag:'gymtok',limit:'50'}});
   ok(r2.json.items.length===1&&r2.json.more===false,'the remainder comes out next pull, then the queue is empty');
   const r3=await t.call('free-pull',{query:{tag:'gymtok'}});
   ok(r3.json.items.length===0,'drained queue stays empty, not an error on the next tick');}
  {const t=setup({...FULL,CADENCE_ACCESS_CODE:'lille59'});
   const r=await t.call('free-pull',{query:{tag:'gymtok'}});
   ok(r.status===401,'the app-facing pull route is behind the same access code as the rest of the backend');}
  {const t=setup(FULL);
   const r=await t.call('free-pull',{query:{}});
   ok(r.status===400,'missing tag rejected');}

  console.log(out.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  if(fail)process.exit(1);
})();
