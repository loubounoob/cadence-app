/* GET /api/free-tags — called by harvest/free-harvest.mjs (the outside
   Playwright harvester), never by the browser. Returns whatever hashtags
   real searches have asked for via /api/free-request since the last time
   the harvester read this list, so the harvester's next pass can widen
   coverage on its own instead of only ever working the fixed list in
   harvest/tags.json. Secret-gated exactly like /api/free-intake — this is
   the harvester's own request, made from CI, not from a browser. */
const {cors,send,kv,K}=require('./_lib');

module.exports=async function handler(req,res){
  if(cors(req,res))return;
  if(req.method!=='GET')return send(res,405,{error:{type:'method',message:'GET only'}});
  const secret=process.env.FREE_HARVEST_SECRET;
  if(!secret)return send(res,503,{error:{type:'not_configured',message:'FREE_HARVEST_SECRET is not set on the server.'}});
  const q=req.query||{};
  if(q.secret!==secret)return send(res,401,{error:{type:'auth',message:'bad secret'}});
  if(!kv.ok)return send(res,200,{ok:true,tags:[]});
  const key=K('free:requested');
  const [tags]=await kv.pipe([['SMEMBERS',key]]).catch(()=>[[]]);
  send(res,200,{ok:true,tags:Array.isArray(tags)?tags:[]});
};
