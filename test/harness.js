/* Test harness: fake Upstash Redis (REST), fake Anthropic, and a way to call the
   real /api handlers in-process. Used by test-backend.js and test-app.js. */
const path=require('path');
const API=path.join(__dirname,'..','api');

function fakeRedis(){
  const s=new Map();const ex=new Map();
  const get=k=>{if(ex.has(k)&&ex.get(k)<Date.now()){s.delete(k);ex.delete(k)}return s.get(k)};
  const H=k=>{let v=get(k);if(!(v instanceof Map)){v=new Map();s.set(k,v)}return v};
  const L=k=>{let v=get(k);if(!Array.isArray(v)){v=[];s.set(k,v)}return v};
  const Se=k=>{let v=get(k);if(!(v instanceof Set)){v=new Set();s.set(k,v)}return v};
  const run=([c,...a])=>{c=c.toUpperCase();
    switch(c){
      case 'GET':{const v=get(a[0]);return v===undefined?null:v}
      case 'SET':{const [k,v,...o]=a;const nx=o.map(x=>String(x).toUpperCase()).includes('NX');
        if(nx&&get(k)!==undefined)return null;s.set(k,String(v));const i=o.map(x=>String(x).toUpperCase()).indexOf('EX');
        if(i>=0)ex.set(k,Date.now()+Number(o[i+1])*1000);return 'OK'}
      case 'DEL':{let n=0;a.forEach(k=>{if(s.delete(k))n++});return n}
      case 'INCRBY':{const v=(Number(get(a[0]))||0)+Number(a[1]);s.set(a[0],String(v));return v}
      case 'EXPIRE':{ex.set(a[0],Date.now()+Number(a[1])*1000);return 1}
      case 'HSET':{const h=H(a[0]);let n=0;for(let i=1;i<a.length;i+=2){if(!h.has(a[i]))n++;h.set(a[i],String(a[i+1]))}return n}
      case 'HDEL':{const h=H(a[0]);let n=0;a.slice(1).forEach(f=>{if(h.delete(f))n++});return n}
      case 'HGETALL':{const h=get(a[0]);if(!(h instanceof Map))return [];return [...h.entries()].flat()}
      case 'HLEN':{const h=get(a[0]);return h instanceof Map?h.size:0}
      case 'LPUSH':{const l=L(a[0]);a.slice(1).forEach(v=>l.unshift(String(v)));return l.length}
      case 'LTRIM':{const l=L(a[0]);const st=+a[1],en=+a[2];s.set(a[0],l.slice(st,en+1));return 'OK'}
      case 'LRANGE':{const l=get(a[0])||[];return l.slice(+a[1],+a[2]+1)}
      case 'LLEN':{return (get(a[0])||[]).length}
      case 'RPUSH':{const l=L(a[0]);a.slice(1).forEach(v=>l.push(String(v)));return l.length}
      case 'HMGET':{const h=get(a[0]);return a.slice(1).map(f=>h instanceof Map&&h.has(f)?h.get(f):null)}
      case 'HEXISTS':{const h=get(a[0]);return h instanceof Map&&h.has(a[1])?1:0}
      case 'SADD':{const l=L(a[0]);let n=0;a.slice(1).forEach(v=>{v=String(v);if(!l.includes(v)){l.push(v);n++}});return n}
      case 'SMEMBERS':{return (get(a[0])||[]).slice()}
      case 'SCARD':{return (get(a[0])||[]).length}
      case 'SPOP':{const l=L(a[0]);const n=a[1]!==undefined?Number(a[1]):1;const out=l.splice(0,n);return a[1]!==undefined?out:(out[0]??null)}
      default:throw new Error('fake redis: unsupported '+c)}};
  return {store:s,cmds:[],async handle(url,opts){
    const body=JSON.parse(opts.body);const isPipe=url.endsWith('/pipeline');
    const list=isPipe?body:[body];this.cmds.push(...list);
    const out=list.map(x=>{try{return {result:run(x)}}catch(e){return {error:e.message}}});
    return {ok:true,status:200,headers:{get:()=>null},json:async()=>isPipe?out:out[0]}}}}

/* Anthropic fake: routes on system prompt; scripted responders per agent. */
function fakeAnthropic(){
  const f={calls:[],scripts:{server:[],ops:[]},failNext:0,
    async handle(url,opts){
      const body=JSON.parse(opts.body);f.calls.push({body,headers:opts.headers});
      if(f.failNext>0){f.failNext--;return resp(529,{type:'error',error:{type:'overloaded_error',message:'Overloaded'}})}
      const sysText=(Array.isArray(body.system)?body.system.map(x=>x.text).join(''):String(body.system||''));
      const last=body.messages[body.messages.length-1];const ut=typeof last.content==='string'?last.content:'';
      if(body.tool_choice&&body.tool_choice.name==='classify_creators'){
        f.classifyListCalls=(f.classifyListCalls||0)+1;
        const lines=ut.split('\n').filter(l=>/^id=/.test(l));
        const results=lines.map(l=>{
          const id=(l.match(/^id=(\S+)/)||[])[1];
          const subs=Number((l.match(/\|\s*([\d,]+)\s*followers/)||[])[1]?.replace(/,/g,''))||0;
          const niche=/sleep|gummies|wellness/i.test(l)?'sleep & wellness':/fit(ness)?/i.test(l)?'fitness':'lifestyle';
          const tier=subs<10000?'nano':subs<100000?'micro':subs<1000000?'mid':'macro';
          return {id,category:niche,tier}});
        return resp(200,{content:[{type:'tool_use',id:'tu_clsl',name:'classify_creators',
          input:{list_summary:'Test-generated niche list',results}}],stop_reason:'tool_use',usage})}
      if(body.tool_choice&&body.tool_choice.name==='classify_replies'){
        f.classifyCalls=(f.classifyCalls||0)+1;
        const Q='"'+'"'+'"';
        const parts=ut.split('\n\n---\n\n');
        const results=parts.map(pt=>{const id=(pt.match(/reply_id=(\S+)/)||[])[1];const msg=(pt.split(Q)[1]||'');
          if(f.skipIds&&f.skipIds.includes(id))return null;
          const intent=/flat fee|\$500|more money/i.test(msg)?'NEGOTIATE':/out of office|vacation/i.test(msg)?'OUT_OF_OFFICE':/no thanks|not interested/i.test(msg)?'DECLINE':/\?/.test(msg)?'QUESTION':'INTERESTED';
          return {reply_id:id,intent:(f.badIntent&&f.badIntent[id])||intent,confidence:/maybe|not sure|hmm/i.test(msg)?0.4:0.95,
            delivery:/damaged|broken/i.test(msg)?'damaged':/never (got|arrived|received)|hasn.t arrived/i.test(msg)?'not_received':/got the (box|package)|it arrived|received it/i.test(msg)?'received':'none',
            has_address:/Rue|Street|Avenue/.test(msg),video_url:(msg.match(/https:\/\/youtu\S+/)||[''])[0],language:'en',summary:msg.trim().slice(0,60)}}).filter(Boolean);
        return resp(200,{content:[{type:'tool_use',id:'tu_cls',name:'classify_replies',input:{results}}],stop_reason:'tool_use',usage})}
      if(/You read one reply/.test(sysText)&&/postal shipping address/.test(ut)){
        const has=/Rue|Street|Avenue/.test(ut);
        return ok(has?'{"found":true,"name":"Nora Quill","line1":"12 Rue Oberkampf","line2":"","city":"Paris","region":"","postal":"75011","country":"France"}':'{"found":false}')}
      if(/You read one reply/.test(sysText)){
        if(/flat fee|\$500|more money/i.test(ut))return ok('NEGOTIATE');
        if(/out of office|vacation/i.test(ut))return ok('OUT_OF_OFFICE');
        if(/no thanks|not interested/i.test(ut))return ok('DECLINE');
        return ok('INTERESTED')}
      if(/You write first-contact/.test(sysText))return ok('Thanks — here is the draft.\n\nLouis');
      const q=/running on the server/.test(sysText)?f.scripts.server:/operations brain of Cadence/.test(sysText)?f.scripts.ops:null;
      if(q){const fn=q.shift();if(!fn)return ok('Done.');return resp(200,fn(body))}
      return ok('?')}};
  return f}
const usage={input_tokens:120,output_tokens:30};
const resp=(status,j)=>({ok:status<300,status,headers:{get:k=>k==='retry-after'?'0':null},json:async()=>j});
const ok=t=>resp(200,{content:[{type:'text',text:t}],stop_reason:'end_turn',usage});
const tool=(name,input,id)=>({content:[{type:'tool_use',id:id||('tu_'+name+Math.random().toString(36).slice(2,6)),name,input}],stop_reason:'tool_use',usage});
const say=t=>({content:[{type:'text',text:t}],stop_reason:'end_turn',usage});
const toolResult=(body,id)=>{for(const m of body.messages)if(Array.isArray(m.content))for(const b of m.content)if(b.type==='tool_result'&&b.tool_use_id===id)return JSON.parse(b.content);return null};

/* Install global fetch for the backend and fresh module state. */
function setup(env){
  const redis=fakeRedis(),anth=fakeAnthropic();
  for(const k of ['ANTHROPIC_API_KEY','KV_REST_API_URL','KV_REST_API_TOKEN','UPSTASH_REDIS_REST_URL','UPSTASH_REDIS_REST_TOKEN','CADENCE_ACCESS_CODE','DAILY_TOKEN_CAP','CRON_SECRET'])delete process.env[k];
  Object.assign(process.env,env||{});
  global.fetch=async(url,opts)=>{url=String(url);
    if(url.startsWith('https://api.anthropic.com/'))return anth.handle(url,opts);
    if(process.env.KV_REST_API_URL&&url.startsWith(process.env.KV_REST_API_URL))return redis.handle(url,opts);
    throw new Error('unexpected fetch '+url)};
  for(const k of Object.keys(require.cache))if(k.startsWith(API))delete require.cache[k];
  const h=n=>require(path.join(API,n+'.js'));
  async function call(name,{method='GET',headers={},body,query={}}={}){
    const req={method,headers:Object.fromEntries(Object.entries(headers).map(([k,v])=>[k.toLowerCase(),v])),body,query};
    const res={statusCode:200,h:{},setHeader(k,v){this.h[k.toLowerCase()]=v},end(d){this.data=d;this.done=true}};
    await h(name)(req,res);
    let json=null;try{json=JSON.parse(res.data||'null')}catch(e){}
    return {status:res.statusCode,json,headers:res.h,raw:res.data||''}}
  return {redis,anth,call,h}}

const FULL={ANTHROPIC_API_KEY:'sk-ant-SECRET-test-key',KV_REST_API_URL:'https://fake-redis.upstash.io',KV_REST_API_TOKEN:'redis-token'};
module.exports={setup,fakeRedis,fakeAnthropic,ok,tool,say,toolResult,resp,FULL};
