/* /api/free-intake — Étage 1 (free collection): receives raw TikTok items
   harvested at zero provider cost (hashtag/sound pages, no paid actor) from
   an external harvester (see harvest/free-harvest.mjs, run by GitHub
   Actions) and queues them in Redis, one list per tag, for the running app
   to drain via /api/free-pull during a discovery job's harvest tick.

   Only a shared secret (FREE_HARVEST_SECRET) may write here — never the
   browser. Rows are adapted, at intake, into the exact shape the app's own
   TikTok adapter (fromTikTok in base.html) already expects from the paid
   provider, so nothing downstream — ingest, triage, deep score, contact
   extraction — needs to know or care where a row came from. */
const {cors,send,body,kv,K}=require('./_lib');
const MAX_QUEUE=4000; // rows kept per tag; oldest dropped first — a job drains fast enough that this is generous

/* item is one entry from TikTok's own public
   www.tiktok.com/api/challenge/item_list (or /api/music/item_list) response —
   the real per-video, per-author object a signed-out visitor's browser
   already receives when it opens a hashtag or sound page. Never guessed:
   every field read here was seen live in that response. */
function adaptItem(item,tag){
  if(!item||typeof item!=='object')return null;
  const a=item.author||{},as=item.authorStats||{},st=item.stats||{};
  const handle=String(a.uniqueId||'').trim();
  if(!handle)return null;
  return {
    text:String(item.desc||'').slice(0,2000),
    textLanguage:String(item.textLanguage||item.language||'').slice(0,5),
    createTimeISO:item.createTime?new Date(Number(item.createTime)*1000).toISOString():'',
    playCount:Number(st.playCount||item.playCount||0)||0,
    diggCount:Number(st.diggCount||item.diggCount||0)||0,
    commentCount:Number(st.commentCount||item.commentCount||0)||0,
    isSponsored:!!(item.isAd||item.isAD||(Array.isArray(item.adAuthorization)&&item.adAuthorization.length)),
    authorMeta:{
      name:handle,
      nickName:String(a.nickname||a.nickName||handle).slice(0,80),
      fans:Number(as.followerCount||a.followerCount||0)||0,
      video:Number(as.videoCount||0)||0,
      heart:Number(as.heart||as.heartCount||0)||0,
      signature:String(a.signature||'').slice(0,500),
      region:String(a.region||'').slice(0,2),
      avatar:String(a.avatarLarger||a.avatarMedium||a.avatarThumb||''),
      verified:!!a.verified},
    searchHashtag:tag?{name:tag}:undefined,
    src:'free'};
}

module.exports=async function handler(req,res){
  if(cors(req,res))return;
  if(req.method!=='POST')return send(res,405,{error:{type:'method',message:'POST only'}});
  const secret=process.env.FREE_HARVEST_SECRET;
  if(!secret)return send(res,503,{error:{type:'not_configured',message:'FREE_HARVEST_SECRET is not set on the server.'}});
  const b=await body(req);
  if(b.secret!==secret)return send(res,401,{error:{type:'auth',message:'bad secret'}});
  const tag=String(b.tag||'').toLowerCase().replace(/[^a-z0-9_]/g,'').slice(0,60);
  if(!tag)return send(res,400,{error:{type:'bad_request',message:'tag required'}});
  const raw=Array.isArray(b.items)?b.items:[];
  const rows=raw.map(x=>adaptItem(x,tag)).filter(Boolean).slice(0,500);
  if(!rows.length)return send(res,200,{ok:true,added:0});
  if(!kv.ok)return send(res,503,{error:{type:'no_storage',message:'No Redis configured — free harvest needs storage to queue rows.'}});
  const key=K('free:'+tag);
  await kv.pipe([
    ['LPUSH',key,...rows.map(r=>JSON.stringify(r))],
    ['LTRIM',key,'0',String(MAX_QUEUE-1)],
    ['EXPIRE',key,String(24*3600)]]);
  send(res,200,{ok:true,added:rows.length});
};
module.exports._internal={adaptItem};
