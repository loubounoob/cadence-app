/* POST /api/free-request — called by the browser (dxTick in discovery.js)
   when a search's own plan needs a hashtag the free harvester hasn't
   collected yet. This is how the free tier stops being a fixed, curated
   list (harvest/tags.json) and starts covering whatever real searches
   actually ask for: the tag is queued here, and the next free-harvest.mjs
   run (harvest/free-harvest.mjs, on a schedule or triggered by hand) reads
   it via /api/free-tags and harvests it too — no redeploy, no manual
   editing of tags.json needed for the system to widen its own coverage. */
const {cors,send,gate,kv,K}=require('./_lib');
const MAX_REQUESTED=200;

module.exports=async function handler(req,res){
  if(cors(req,res))return;
  if(!gate(req,res))return;
  if(req.method!=='POST')return send(res,405,{error:{type:'method',message:'POST only'}});
  let b={};try{b=req.body&&typeof req.body==='object'?req.body:JSON.parse(req.body||'{}')}catch(e){}
  const tag=String(b.tag||'').toLowerCase().replace(/[^a-z0-9_]/g,'').slice(0,60);
  if(!tag)return send(res,400,{error:{type:'bad_request',message:'tag required'}});
  if(!kv.ok)return send(res,200,{ok:true,queued:false});
  const key=K('free:requested');
  await kv.pipe([['SADD',key,tag],['EXPIRE',key,String(24*3600)]]).catch(()=>{});
  // keep the set from growing unbounded if nothing ever drains it
  const [size]=await kv.pipe([['SCARD',key]]).catch(()=>[0]);
  if(Number(size)>MAX_REQUESTED)await kv.pipe([['SPOP',key,String(Number(size)-MAX_REQUESTED)]]).catch(()=>{});
  send(res,200,{ok:true,queued:true});
};
