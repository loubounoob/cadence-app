/* GET /api/health — what the backend can do right now. Never returns secrets. */
const {MODEL,cors,send,kv,K,today}=require('./_lib');

module.exports=async function handler(req,res){
  if(cors(req,res))return;
  let storage=kv.ok,used=null,lastAgent=null;
  if(storage){
    try{const [u,la]=await kv.pipe([['GET',K('usage:'+today())],['GET',K('agent:last')]]);
      used=Number(u)||0;try{lastAgent=la?JSON.parse(la):null}catch(e){}}
    catch(e){storage=false}}
  send(res,200,{ok:true,model:MODEL,key:!!process.env.ANTHROPIC_API_KEY,storage,
    access_code:!!process.env.CADENCE_ACCESS_CODE,tokens_today:used,
    daily_cap:Number(process.env.DAILY_TOKEN_CAP)||3000000,last_agent_run:lastAgent,time:new Date().toISOString()});
};
