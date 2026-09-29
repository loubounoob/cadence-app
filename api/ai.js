/* POST /api/ai — proxy to Anthropic Messages. The browser sends system,
   messages and tools; the server adds the key and forces Sonnet. */
const {cors,send,gate,body,anthropic}=require('./_lib');

module.exports=async function handler(req,res){
  if(cors(req,res))return;
  if(req.method!=='POST')return send(res,405,{error:{type:'method',message:'POST only'}});
  if(!gate(req,res))return;
  try{
    const r=await anthropic(await body(req));
    if(r.retryAfter)res.setHeader('retry-after',r.retryAfter);
    send(res,r.status,r.json);
  }catch(e){send(res,502,{error:{type:'upstream',message:e.message}})}
};
