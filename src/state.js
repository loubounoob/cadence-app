/* ═══ STATE — built for thousands of creators ════════════════════════════
   localStorage holds ~5 MB and the old save() swallowed the error when it
   filled up: past a few thousand creators, changes were silently lost.

   Now: settings stay in localStorage (small, read synchronously at boot). The
   collections that grow with volume live in IndexedDB, one entry each, only
   rewritten when they change. Boot reads settings at once, then hydrates the
   collections before anything that writes to them starts. Backups older than
   this build (everything in localStorage) load as before and move over on the
   first save. */
const HEAVY=[
  ['pipe',d=>d.pipe,(d,v)=>{d.pipe=v}],
  ['campaigns',d=>d.campaigns,(d,v)=>{d.campaigns=v}],
  ['lists',d=>d.lists,(d,v)=>{d.lists=v}],
  ['out.sent',d=>d.out&&d.out.sent,(d,v)=>{if(!d.out)d.out={};d.out.sent=v}],
  ['out.ailog',d=>d.out&&d.out.ailog,(d,v)=>{if(!d.out)d.out={};d.out.ailog=v}],
  ['out.inbox.replies',d=>d.out&&d.out.inbox&&d.out.inbox.replies,(d,v)=>{if(!d.out)d.out={};if(!d.out.inbox)d.out.inbox={mode:'semi',replies:[],lastSync:0};d.out.inbox.replies=v}],
  ['ai.events',d=>d.ai&&d.ai.events,(d,v)=>{if(!d.ai)d.ai={};d.ai.events=v}],
  ['ai.insights',d=>d.ai&&d.ai.insights,(d,v)=>{if(!d.ai)d.ai={};d.ai.insights=v}],
  ['ai.approvals',d=>d.ai&&d.ai.approvals,(d,v)=>{if(!d.ai)d.ai={};d.ai.approvals=v}],
  ['ai.chat',d=>d.ai&&d.ai.chat,(d,v)=>{if(!d.ai)d.ai={};d.ai.chat=v}],
  ['ai.flags',d=>d.ai&&d.ai.flags,(d,v)=>{if(!d.ai)d.ai={};d.ai.flags=v}],
  ['ai.sync.hashes',d=>d.ai&&d.ai.sync&&d.ai.sync.hashes,(d,v)=>{if(!d.ai)d.ai={};if(!d.ai.sync)d.ai.sync={hashes:{},lastAt:0,ack:[]};d.ai.sync.hashes=v}],
];
let stateReady=false,stateWarn='';
const heavyLast={};let heavyTimer=null;
let _sdb=null;
function stateIdb(){return _sdb?Promise.resolve(_sdb):new Promise((res,rej)=>{
  if(typeof indexedDB==='undefined')return rej(new Error('no IndexedDB'));
  const r=indexedDB.open('cadence-state',1);
  r.onupgradeneeded=()=>{if(!r.result.objectStoreNames.contains('kv'))r.result.createObjectStore('kv')};
  r.onsuccess=()=>{_sdb=r.result;res(_sdb)};r.onerror=()=>rej(r.error)})}

function lightCopy(){
  const c={...db};delete c.pipe;delete c.campaigns;delete c.lists;
  if(db.out){c.out={...db.out};delete c.out.sent;delete c.out.ailog;
    if(db.out.inbox){c.out.inbox={...db.out.inbox};delete c.out.inbox.replies}}
  if(db.ai){c.ai={...db.ai};['events','insights','approvals','chat','flags'].forEach(k=>delete c.ai[k]);
    if(db.ai.sync){c.ai.sync={...db.ai.sync};delete c.ai.sync.hashes}}
  c._split=1;return c}

function save(){
  if(!stateReady){ // before hydration: keep the old full format so nothing can be lost
    try{localStorage.setItem('cadence',JSON.stringify(db))}catch(e){stateWarn='Browser storage is full — '+e.message}
    return}
  try{localStorage.setItem('cadence',JSON.stringify(lightCopy()))}catch(e){stateWarn='Settings could not be saved — '+e.message}
  if(!heavyTimer)heavyTimer=setTimeout(persistHeavy,600)}

async function persistHeavy(){
  heavyTimer=null;if(!stateReady)return;
  try{
    const d=await stateIdb();const writes=[];
    for(const [k,get] of HEAVY){const v=get(db);if(v===undefined)continue;
      const s=JSON.stringify(v);const sig=s.length+':'+hashLite(s);
      if(heavyLast[k]!==sig){writes.push([k,s]);heavyLast[k]=sig}}
    if(!writes.length)return;
    await new Promise((res,rej)=>{const t=d.transaction('kv','readwrite'),st=t.objectStore('kv');
      writes.forEach(([k,s])=>st.put(s,k));t.oncomplete=res;t.onerror=()=>rej(t.error);t.onabort=()=>rej(t.error)});
    stateWarn='';
  }catch(e){stateWarn='Could not write to IndexedDB — '+e.message;writes_failed(e)}}
function writes_failed(){for(const k of Object.keys(heavyLast))delete heavyLast[k]}
function hashLite(s){let h=5381;const step=Math.max(1,Math.floor(s.length/4000));
  for(let i=0;i<s.length;i+=step)h=((h<<5)+h+s.charCodeAt(i))|0;return (h>>>0).toString(36)}

function load(){try{const d=localStorage.getItem('cadence');if(d)db=JSON.parse(d)}catch(e){}
  delete db._split;
  if(!db.campaigns)db.campaigns=[];if(!db.setup)db.setup={};
  if(!db.pipe)db.pipe={};
  if(!db.lists)db.lists=[];
  if(!db.disc)db.disc={};
  db.disc={q:'',days:7,depth:2,minSub:5000,maxSub:500000,lang:'en',...db.disc};
  if(!db.quota)db.quota={date:'',used:0};
  if(!db.frontier)db.frontier={};
  if(!db.prov)db.prov={token:'',actors:{}};
  if(!db.ref)db.ref={ads:12,influencer:33};
  if(!db.brand)db.brand={shop:'',token:'',product:'',price:'',url:'',market:'US',linked:false};
  if(!db.out)db.out={fromName:'',fromEmail:'',replyTo:'',rate:5,
    subject:'',body:'',startHour:9,endHour:17,perDay:40,minGapMin:6,queue:[],sent:[],running:false,nextAt:0};
  if(!db.out.sent)db.out.sent=[];
  if(!db.mail)db.mail={provider:'google',tok:null,verified:null};
  if(!db.ai)db.ai={};
  if(!db.brief)db.brief={market:'US',minMed:5000,maxCost:400,budget:25000,band:'any',
    needEmail:true,direct:false,category:false,noMinors:true,minAuth:60,recency:60};}

/* Reads the collections from IndexedDB. What IndexedDB has wins; what it does
   not have (first run after upgrading) is kept from localStorage and moved over. */
async function stateHydrate(){
  try{
    const d=await stateIdb();
    const got=await new Promise((res,rej)=>{const out={};const t=d.transaction('kv','readonly'),st=t.objectStore('kv');
      HEAVY.forEach(([k])=>{const g=st.get(k);g.onsuccess=()=>{if(g.result!==undefined)out[k]=g.result}});
      t.oncomplete=()=>res(out);t.onerror=()=>rej(t.error)});
    for(const [k,,set] of HEAVY)if(got[k]!==undefined){try{set(db,JSON.parse(got[k]));heavyLast[k]=got[k].length+':'+hashLite(got[k])}catch(e){}}
  }catch(e){stateWarn='IndexedDB unavailable — using browser storage only ('+e.message+')'}
  if(!db.pipe)db.pipe={};if(!db.campaigns)db.campaigns=[];if(!db.lists)db.lists=[];if(!db.out.sent)db.out.sent=[];
  if(!_sdb)return; // no IndexedDB at all: stay on the old single-blob format
  stateReady=true;
  await persistHeavy(); // anything not yet in IndexedDB goes there first…
  save()}               // …then localStorage shrinks to settings only

if(typeof document!=='undefined')document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='hidden'&&stateReady){clearTimeout(heavyTimer);persistHeavy()}});

/* One place that answers "how big is this account?" — shown in Copilot. */
function stateStats(){return {creators:Object.keys(db.pipe||{}).length,lists:(db.lists||[]).length,sent:(db.out.sent||[]).length,
  replies:((db.out.inbox||{}).replies||[]).length,events:((db.ai||{}).events||[]).length,
  settingsKB:Math.round((()=>{try{return (localStorage.getItem('cadence')||'').length}catch(e){return 0}})()/1024),
  mode:stateReady?'IndexedDB':'browser storage',warn:stateWarn}}
