/* POST /api/sync — the app pushes what changed, pulls what the server agent did.
   body: { records:{pipe|reply|sent|camp:{id:rec}}, removed:{coll:[id]}, events:[...],
           meta:{brand,out,auto,flags,stages}, ack:[opId] }
   returns: { storage, ops:[...], serverTime } */
const {cors,send,gate,body,kv,K,hgetallObj}=require('./_lib');
const COLLS=new Set(['pipe','reply','sent','camp','list']);
const MAX_CMD_BYTES=600000;

module.exports=async function handler(req,res){
  if(cors(req,res))return;
  if(req.method!=='POST')return send(res,405,{error:{type:'method',message:'POST only'}});
  if(!gate(req,res))return;
  if(!kv.ok)return send(res,200,{storage:false,ops:[],serverTime:Date.now()});
  try{
    const b=await body(req);
    const cmds=[];
    for(const [coll,recs] of Object.entries(b.records||{})){
      if(!COLLS.has(coll)||!recs||typeof recs!=='object')continue;
      let cur=['HSET',K('rec:'+coll)],size=0;
      for(const [id,rec] of Object.entries(recs)){
        const v=JSON.stringify(rec);
        if(size+v.length>MAX_CMD_BYTES&&cur.length>2){cmds.push(cur);cur=['HSET',K('rec:'+coll)];size=0}
        cur.push(String(id),v);size+=v.length}
      if(cur.length>2)cmds.push(cur)}
    for(const [coll,ids] of Object.entries(b.removed||{}))
      if(COLLS.has(coll)&&Array.isArray(ids)&&ids.length)cmds.push(['HDEL',K('rec:'+coll),...ids.map(String)]);
    const evs=(Array.isArray(b.events)?b.events:[]).slice(0,300);
    if(evs.length){cmds.push(['LPUSH',K('events'),...evs.slice().reverse().map(e=>JSON.stringify(e))]);cmds.push(['LTRIM',K('events'),'0','1999'])}
    if(b.meta&&typeof b.meta==='object')cmds.push(['SET',K('meta'),JSON.stringify(b.meta)]);
    const ack=(Array.isArray(b.ack)?b.ack:[]).map(String);
    if(ack.length)cmds.push(['HDEL',K('ops'),...ack]);
    cmds.push(['SET',K('sync:last'),String(Date.now())]);
    cmds.push(['HGETALL',K('ops')]);
    const out=await kv.pipe(cmds);
    const ops=Object.values(hgetallObj(out[out.length-1])).sort((x,y)=>String(x.at).localeCompare(String(y.at)));
    send(res,200,{storage:true,ops,serverTime:Date.now()});
  }catch(e){send(res,500,{error:{type:'sync',message:e.message}})}
};
