/* /api/free-pull — the running app drains this during a discovery job's
   harvest tick, one tag at a time, instead of paying the provider for that
   tag's rows. Behind the same access-code gate as every other client-facing
   route (ai.js, sync.js) — this is called from the browser, not the harvester. */
const {cors,send,gate,kv,K}=require('./_lib');

module.exports=async function handler(req,res){
  if(cors(req,res))return;
  if(!gate(req,res))return;
  if(req.method!=='GET')return send(res,405,{error:{type:'method',message:'GET only'}});
  const q=req.query||{};
  const tag=String(q.tag||'').toLowerCase().replace(/[^a-z0-9_]/g,'').slice(0,60);
  if(!tag)return send(res,400,{error:{type:'bad_request',message:'tag required'}});
  if(!kv.ok)return send(res,200,{ok:true,items:[],more:false});
  const limit=Math.max(1,Math.min(1000,Number(q.limit)||500));
  const key=K('free:'+tag);
  const [lenBefore]=await kv.pipe([['LLEN',key]]);
  const total=Number(lenBefore||0);
  if(!total)return send(res,200,{ok:true,items:[],more:false});
  const take=Math.min(limit,total);
  const [raw]=await kv.pipe([['LRANGE',key,'0',String(take-1)]]);
  if(take>=total)await kv.pipe([['DEL',key]]);
  else await kv.pipe([['LTRIM',key,String(take),String(total-1)]]);
  const items=(Array.isArray(raw)?raw:[]).map(s=>{try{return JSON.parse(s)}catch(e){return null}}).filter(Boolean);
  send(res,200,{ok:true,items,more:take<total});
};
