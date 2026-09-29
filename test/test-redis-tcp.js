// Proves the real backend picks REDIS_URL (Vercel's native Redis, TCP/RESP)
// over the old REST vars when set, against a real fake TCP RESP server —
// not the REST fake the other suites use. node test/test-redis-tcp.js
const net=require('net'),path=require('path');
let pass=0,fail=0;const ok=(c,m)=>{if(c){pass++;console.log('  ✓',m)}else{fail++;console.log('  ✗',m)}};

function startFakeRedisServer(pass_){
  const store={};
  const srv=net.createServer(sock=>{
    let buf=Buffer.alloc(0);
    sock.on('data',d=>{
      buf=Buffer.concat([buf,d]);
      while(true){
        if(buf[0]!==0x2a)break;
        const nl=buf.indexOf('\r\n');if(nl===-1)break;
        const n=parseInt(buf.toString('ascii',1,nl),10);
        let off=nl+2;const args=[];let complete=true;
        for(let i=0;i<n;i++){
          if(buf[off]!==0x24){complete=false;break}
          const nl2=buf.indexOf('\r\n',off);if(nl2===-1){complete=false;break}
          const len=parseInt(buf.toString('ascii',off+1,nl2),10);
          const vstart=nl2+2;
          if(buf.length<vstart+len+2){complete=false;break}
          args.push(buf.toString('utf8',vstart,vstart+len));off=vstart+len+2}
        if(!complete)break;
        buf=buf.slice(off);
        const cmd=(args[0]||'').toUpperCase();let reply;
        if(cmd==='AUTH')reply=(args[2]===pass_)?'+OK\r\n':'-ERR invalid password\r\n';
        else if(cmd==='SET'){store[args[1]]=args[2];reply='+OK\r\n'}
        else if(cmd==='GET'){const v=store[args[1]];reply=v===undefined?'$-1\r\n':`$${Buffer.byteLength(v)}\r\n${v}\r\n`}
        else if(cmd==='INCRBY'){const c2=parseInt(store[args[1]]||'0',10)+parseInt(args[2],10);store[args[1]]=String(c2);reply=`:${c2}\r\n`}
        else if(cmd==='EXPIRE')reply=':1\r\n';
        else if(cmd==='HSET'){const h=args[1];store[h]=store[h]||{};let a2=0;for(let i=2;i<args.length;i+=2){if(store[h][args[i]]===undefined)a2++;store[h][args[i]]=args[i+1]}reply=`:${a2}\r\n`}
        else if(cmd==='HGETALL'){const h=store[args[1]]||{};const flat=[];for(const [k,v] of Object.entries(h))flat.push(k,v);
          reply=`*${flat.length}\r\n`+flat.map(x=>`$${Buffer.byteLength(x)}\r\n${x}\r\n`).join('')}
        else reply='+OK\r\n';
        sock.write(reply)}})});
  return new Promise(res=>srv.listen(0,'127.0.0.1',()=>res({srv,port:srv.address().port})));}

(async()=>{
  const {srv,port}=await startFakeRedisServer('tcp-secret');
  for(const k of ['ANTHROPIC_API_KEY','KV_REST_API_URL','KV_REST_API_TOKEN','UPSTASH_REDIS_REST_URL','UPSTASH_REDIS_REST_TOKEN','REDIS_URL','CADENCE_ACCESS_CODE','DAILY_TOKEN_CAP','CRON_SECRET'])delete process.env[k];
  process.env.ANTHROPIC_API_KEY='sk-ant-SECRET-test-key';
  process.env.REDIS_URL=`redis://default:tcp-secret@127.0.0.1:${port}`;
  const origFetch=global.fetch;
  global.fetch=async(url,opts)=>{url=String(url);
    if(url.startsWith('https://api.anthropic.com/')){
      const body=JSON.parse(opts.body);
      return {ok:true,status:200,headers:{get:()=>null},json:async()=>({content:[{type:'text',text:'ok'}],stop_reason:'end_turn',usage:{input_tokens:10,output_tokens:5}})}}
    throw new Error('unexpected REST fetch to '+url+' — should be using the TCP client for Redis')};
  for(const k of Object.keys(require.cache))if(k.startsWith(path.join(__dirname,'..','api')))delete require.cache[k];
  const health=require(path.join(__dirname,'..','api','health.js'));
  const ai=require(path.join(__dirname,'..','api','ai.js'));
  const call=async(h,{method='GET',headers={},body}={})=>{
    const req={method,headers:Object.fromEntries(Object.entries(headers).map(([k,v])=>[k.toLowerCase(),v])),body};
    const res={statusCode:200,h:{},setHeader(k,v){this.h[k.toLowerCase()]=v},end(d){this.data=d}};
    await h(req,res);return {status:res.statusCode,json:JSON.parse(res.data||'null')}};

  const h1=await call(health);
  ok(h1.json.storage===true,'health reports storage:true — REDIS_URL picked up, no REST call made ('+JSON.stringify(h1.json)+')');

  const a1=await call(ai,{method:'POST',body:JSON.stringify({messages:[{role:'user',content:'hi'}]})});
  ok(a1.status===200,'an /api/ai call succeeds end-to-end with Redis reached only over TCP');
  const a2=await call(ai,{method:'POST',body:JSON.stringify({messages:[{role:'user',content:'hi again'}]})});
  ok(a2.status===200,'second call also succeeds (token usage metered via TCP INCRBY/EXPIRE, no REST fetch)');

  global.fetch=origFetch;srv.close();
  console.log(`\n${pass} passed, ${fail} failed`);process.exit(fail?1:0);
})();
