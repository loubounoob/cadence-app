/* Shared backend helpers. Files starting with "_" are not exposed as routes.

   Secrets (Vercel → Project → Settings → Environment Variables):
     ANTHROPIC_API_KEY    required. Never sent to the browser.
     REDIS_URL             set automatically when a Redis database is added
                           from the Vercel Storage tab. A raw redis://host:port
                           connection string, not a REST API — talked to
                           directly over TCP/TLS by _redis.js (no npm driver,
                           so no build step is needed for this static deploy).
                           Without it the agent only runs while the app is open.
     KV_REST_API_URL /    older path: set if an Upstash Redis was instead
     KV_REST_API_TOKEN    added from the Marketplace, which exposes a REST API.
                           Used only when REDIS_URL is absent.
     CADENCE_ACCESS_CODE  optional. When set, every call must carry it.
     DAILY_TOKEN_CAP      optional. Tokens per day across all calls (default 3,000,000).
     CRON_SECRET          optional. Vercel sends it to the cron route. */
const redisTcp=require('./_redis');
const MODEL='claude-sonnet-5';
/* Two-tier model access: the browser can ask for a "tier" (never a raw model
   string, so it can never smuggle in a model we didn't choose). "sonnet" is
   the default and the only tier older clients ever sent, so nothing already
   deployed changes behaviour. "haiku" exists for high-volume, low-stakes
   passes (e.g. a first coarse creator-fit triage over thousands of rows)
   where Sonnet-level judgment would cost far more than the task needs. */
const MODELS={sonnet:MODEL,haiku:'claude-haiku-4-5-20251001'};
const PREFIX='cadence:';

function cors(req,res){
  res.setHeader('Access-Control-Allow-Origin',req.headers.origin||'*');
  res.setHeader('Vary','Origin');
  res.setHeader('Access-Control-Allow-Headers','content-type,x-cadence-code');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Cache-Control','no-store');
  if(req.method==='OPTIONS'){res.statusCode=204;res.end();return true}
  return false}

function send(res,status,obj){res.statusCode=status;res.setHeader('content-type','application/json');res.end(JSON.stringify(obj))}

function gate(req,res){
  const code=process.env.CADENCE_ACCESS_CODE;
  if(code&&req.headers['x-cadence-code']!==code){
    send(res,401,{error:{type:'access_code',message:'This backend needs the access code (Copilot → Access code).'}});return false}
  return true}

async function body(req){
  if(req.body&&typeof req.body==='object')return req.body;
  if(typeof req.body==='string'){try{return JSON.parse(req.body)}catch(e){return {}}}
  return await new Promise(r=>{let d='';req.on('data',c=>d+=c);req.on('end',()=>{try{r(JSON.parse(d||'{}'))}catch(e){r({})}});req.on('error',()=>r({}))})}

/* ── Redis: either a raw TCP connection string (REDIS_URL, Vercel's own
   Redis product) or an Upstash REST endpoint (KV_REST_API_URL/TOKEN, the
   older Marketplace product) — whichever is configured. Same kv.pipe/kv.cmd
   interface either way, so nothing else in the backend has to know which. */
function kvCfg(){
  const tcpUrl=process.env.REDIS_URL||process.env.KV_URL||'';
  if(tcpUrl)return {mode:'tcp',url:tcpUrl};
  const url=process.env.KV_REST_API_URL||process.env.UPSTASH_REDIS_REST_URL||'';
  const token=process.env.KV_REST_API_TOKEN||process.env.UPSTASH_REDIS_REST_TOKEN||'';
  return url&&token?{mode:'rest',url:url.replace(/\/$/,''),token}:null}
async function pipeRest(c,cmds){
  const r=await fetch(c.url+'/pipeline',{method:'POST',headers:{Authorization:'Bearer '+c.token,'content-type':'application/json'},
    body:JSON.stringify(cmds)});
  const j=await r.json();
  if(!Array.isArray(j))throw new Error((j&&j.error)||'Redis error');
  const bad=j.find(x=>x&&x.error);if(bad)throw new Error('Redis: '+bad.error);
  return j.map(x=>x.result)}
const kv={
  get ok(){return !!kvCfg()},
  async pipe(cmds){
    const c=kvCfg();if(!c)throw new Error('No Redis configured');
    if(!cmds.length)return [];
    return c.mode==='tcp'?redisTcp.pipe(c.url,cmds):pipeRest(c,cmds)},
  async cmd(...args){return (await kv.pipe([args]))[0]},
};
const K=k=>PREFIX+k;
function hgetallObj(flat){const o={};if(!Array.isArray(flat))return o;
  for(let i=0;i<flat.length;i+=2){try{o[flat[i]]=JSON.parse(flat[i+1])}catch(e){}}return o}

/* ── Anthropic: the only place the key is read. Model is forced. ───────── */
const ALLOWED=['system','messages','tools','tool_choice','max_tokens','temperature','stop_sequences'];
function today(){return new Date().toISOString().slice(0,10)}
async function capCheck(){
  if(!kv.ok)return null;
  const cap=Number(process.env.DAILY_TOKEN_CAP)||3000000;
  const used=Number(await kv.cmd('GET',K('usage:'+today())))||0;
  return used>=cap?{used,cap}:null}
async function capAdd(u){
  if(!kv.ok||!u)return;
  const n=(u.input_tokens||0)+(u.output_tokens||0);if(!n)return;
  await kv.pipe([['INCRBY',K('usage:'+today()),String(n)],['EXPIRE',K('usage:'+today()),String(3*86400)]])}

async function anthropic(payload){
  const key=process.env.ANTHROPIC_API_KEY;
  if(!key)return {status:503,json:{error:{type:'no_key',message:'ANTHROPIC_API_KEY is not set on the server.'}}};
  const over=await capCheck().catch(()=>null);
  if(over)return {status:429,json:{error:{type:'daily_cap',message:`Daily AI budget reached (${over.used.toLocaleString('en-US')} tokens). It resets at midnight UTC.`}}};
  const req={};for(const k of ALLOWED)if(payload[k]!==undefined)req[k]=payload[k];
  req.model=MODELS[payload.tier]||MODELS.sonnet;
  req.max_tokens=Math.min(Number(req.max_tokens)||1024,4096);
  if(!Array.isArray(req.messages)||!req.messages.length)return {status:400,json:{error:{type:'bad_request',message:'messages required'}}};
  const r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',
    headers:{'content-type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01'},body:JSON.stringify(req)});
  let j;try{j=await r.json()}catch(e){j={error:{type:'bad_gateway',message:'Unreadable answer from Anthropic'}}}
  if(r.ok)await capAdd(j.usage).catch(()=>{});
  return {status:r.status,json:j,retryAfter:r.headers.get('retry-after')}}

module.exports={MODEL,MODELS,cors,send,gate,body,kv,K,hgetallObj,anthropic,today};
