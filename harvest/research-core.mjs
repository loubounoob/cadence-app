/* ═══ Deep creator research — pure logic (no network, no browser) ════════════
   Everything here is deterministic and unit-tested (test/test-research-core.mjs).
   research-worker.mjs does the IO: a headless Chromium for hashtag feeds,
   plain HTTP for profiles / creator embeds / video pages / bio links, and the
   model through /api/research?op=ai.

   Funnel, per job:
     1. PLAN        Sonnet turns the brief into 80–150 hashtags (head/mid/long
                    tail, every market language) + disqualifiers + a rubric.
     2. DISCOVER    each hashtag's public feed (~60 recent posts) → authors.
                    Accepted creators' own hashtags and @mentions feed back in
                    (snowball), steered by a Sonnet supervisor.
     3. GATE        plain code: follower band, private, disqualifier words.
     4. TRIAGE      Haiku, 40 at a time, throws out the clear no's only.
     5. DOSSIER     plain HTTP: profile (bio, link, language, totals), creator
                    embed (10 latest + pinned videos, captions, views), 3 video
                    pages (likes, comments, shares) → real metrics.
     6. VET         deep review against the brief: niche, values, brand safety,
                    audience, content quality, engagement. Balanced mode: Haiku
                    first, Sonnet re-reads every borderline case; Max mode:
                    Sonnet reads everyone.
     7. ENRICH      contacts from the bio and the bio-link page (email,
                    Instagram, YouTube, site).
   ════════════════════════════════════════════════════════════════════════ */

export const LIMITS={TRIAGE_BATCH:40,DEEP_BATCH_SONNET:5,DEEP_BATCH_HAIKU:6,MAX_TAGS:1500,SUPERVISE_EVERY_TAGS:30,MAX_SNOWBALL_PER_STEP:40};

export const EMAIL_RE=/[A-Za-z0-9._%+-]+\s?(?:@|\(at\)|\[at\]| at )\s?[A-Za-z0-9-]+(?:\s?(?:\.|\(dot\)|\[dot\]| dot )\s?[A-Za-z0-9-]+)*\s?(?:\.|\(dot\)|\[dot\]| dot )\s?[A-Za-z]{2,}/g;
const BAD_EMAIL=/(example|sentry|wixpress|@2x|\.png|\.jpg|\.webp|noreply|no-reply|domain\.com|email\.com$)/i;

export const cleanTag=t=>String(t||'').toLowerCase().replace(/^#/,'').replace(/[^\p{L}\p{N}_]/gu,'').slice(0,60);
export const cleanHandle=h=>String(h||'').toLowerCase().replace(/^@/,'').replace(/[^a-z0-9._]/g,'').slice(0,40);
export const median=a=>{const s=a.filter(x=>Number.isFinite(x)).sort((x,y)=>x-y);if(!s.length)return 0;const m=s.length>>1;return s.length%2?s[m]:Math.round((s[m-1]+s[m])/2)};
export const idToTime=id=>{try{return Number(BigInt(String(id))>>32n)*1000}catch(e){return 0}};

/* ── brief normalisation: whatever the chat produced, the worker gets sane defaults ── */
export function normBrief(b){
  b=b||{};
  const arr=v=>(Array.isArray(v)?v:String(v||'').split(/[,\n]/)).map(x=>String(x).trim()).filter(Boolean);
  const f=b.followers||{};
  return {
    title:String(b.title||b.brand||'Research').slice(0,120),
    brand:String(b.brand||'').slice(0,120),product:String(b.product||'').slice(0,400),goal:String(b.goal||'').slice(0,400),
    niche_summary:String(b.niche_summary||b.persona||'').slice(0,1200),
    persona:String(b.persona||'').slice(0,600),
    must_have:arr(b.must_have).slice(0,20),nice_to_have:arr(b.nice_to_have).slice(0,20),
    exclude:arr(b.exclude).slice(0,30),values:arr(b.values).slice(0,20),tone:String(b.tone||'').slice(0,300),
    audience:String(typeof b.audience==='object'?JSON.stringify(b.audience):b.audience||'').slice(0,400),
    markets:arr(b.markets).map(x=>x.toUpperCase().slice(0,2)).slice(0,10),
    languages:arr(b.languages).map(x=>x.toLowerCase().slice(0,2)).slice(0,6),
    followers:{min:Math.max(0,Number(f.min)||5000),max:Math.max(1000,Number(f.max)||1000000)},
    target_count:Math.max(10,Math.min(20000,Number(b.target_count)||500)),
    min_score:Math.max(40,Math.min(95,Number(b.min_score)||72)),
    max_inactive_days:Math.max(7,Math.min(365,Number(b.max_inactive_days)||45)),
    min_median_views:Math.max(0,Number(b.min_median_views)||0),
    seed_hashtags:arr(b.seed_hashtags).map(cleanTag).filter(Boolean).slice(0,80),
    example_creators:arr(b.example_creators).map(cleanHandle).filter(Boolean).slice(0,30),
    quality:b.quality==='max'?'max':'balanced',
    max_cost_usd:Math.max(2,Number(b.max_cost_usd)||Math.max(10,Math.round(Math.max(10,Math.min(20000,Number(b.target_count)||500))*0.04))),
    summary_language:String(b.summary_language||b.language||'en').slice(0,5),
    contact_required:!!b.contact_required}}

export function briefText(b){
  const L=[];
  L.push(`Brand: ${b.brand||'(unnamed)'}${b.product?' — '+b.product:''}`);
  if(b.goal)L.push(`Campaign goal: ${b.goal}`);
  L.push(`Who we want: ${b.niche_summary}`);
  if(b.persona)L.push(`Ideal creator: ${b.persona}`);
  if(b.must_have.length)L.push(`MUST have: ${b.must_have.join('; ')}`);
  if(b.nice_to_have.length)L.push(`Nice to have: ${b.nice_to_have.join('; ')}`);
  if(b.values.length)L.push(`Values the creator must embody: ${b.values.join('; ')}`);
  if(b.exclude.length)L.push(`NEVER (hard disqualifiers): ${b.exclude.join('; ')}`);
  if(b.tone)L.push(`Tone: ${b.tone}`);
  if(b.audience)L.push(`Target audience: ${b.audience}`);
  L.push(`Markets: ${b.markets.join(', ')||'any'} · Languages: ${b.languages.join(', ')||'any'} · Followers ${b.followers.min}–${b.followers.max}`);
  if(b.example_creators.length)L.push(`Creators the brand already likes (reference points): ${b.example_creators.map(h=>'@'+h).join(', ')}`);
  return L.join('\n')}

/* ── state ──────────────────────────────────────────────────────────────── */
export function newState(brief){
  const tags={};
  brief.seed_hashtags.forEach(t=>{tags[t]={src:'brief',pri:90,st:'todo',posts:0,authors:0,passed:0,acc:0}});
  return {v:1,planned:false,tags,seen:{},cand:{},triageQ:[],fetchQ:[],deepQ:[],escalateQ:[],probeQ:[],
    dossiers:{},hashCo:{},mentions:{},reasons:{},notes:[],
    stats:{postsRead:0,authorsSeen:0,gated:0,triaged:0,triagePassed:0,dossiers:0,dossierFail:0,vetted:0,escalated:0,accepted:0,rejected:0,
      tagsDone:0,tokensIn:0,tokensOut:0,costUsd:0,elapsedMs:0},
    tagsSinceSupervise:0,supervisions:0,expansionsDry:0,done:false}}

export function addTags(s,list,src,pri){
  let n=0;
  for(const x of list||[]){const t=cleanTag(typeof x==='string'?x:x.tag);if(!t||t.length<2)continue;
    if(Object.keys(s.tags).length>=LIMITS.MAX_TAGS)break;
    if(s.tags[t]){if(s.tags[t].st==='todo')s.tags[t].pri=Math.max(s.tags[t].pri,Number(x.pri)||pri||50);continue}
    s.tags[t]={src,pri:Number(x.pri)||pri||50,st:'todo',posts:0,authors:0,passed:0,acc:0};n++}
  return n}

export function nextTag(s){
  let best=null;
  for(const [t,v] of Object.entries(s.tags))if(v.st==='todo'&&(!best||v.pri>s.tags[best].pri))best=t;
  return best}

/* ── discover: a hashtag feed page → candidates ─────────────────────────── */
export function ingestFeed(s,brief,tag,items){
  const T=s.tags[tag];if(T){T.st='done';T.posts=items.length}
  s.stats.postsRead+=items.length;s.stats.tagsDone++;s.tagsSinceSupervise++;
  const fresh=new Set();
  for(const it of items){
    const a=it&&it.author;if(!a)continue;
    const h=cleanHandle(a.uniqueId);if(!h)continue;
    const st=(it.authorStats||{});const vs=it.stats||{};
    const known=s.seen[h];
    if(known&&!s.cand[h])continue;             // already decided
    let c=s.cand[h];
    if(!c){c=s.cand[h]={f:Number(st.followerCount)||0,hearts:Number(st.heartCount||st.heart)||0,vids:Number(st.videoCount)||0,
      sig:String(a.signature||'').slice(0,300),nick:String(a.nickname||'').slice(0,80),ver:!!a.verified,priv:!!a.privateAccount,
      avatar:String(a.avatarMedium||a.avatarThumb||''),cap:[],views:[],lang:[],via:[]};
      s.stats.authorsSeen++;if(T)T.authors++}
    if(c.cap.length<4)c.cap.push(String(it.desc||'').replace(/\s+/g,' ').slice(0,160));
    c.views.push(Number(vs.playCount)||0);
    if(it.textLanguage)c.lang.push(String(it.textLanguage).slice(0,2));
    if(!c.via.includes(tag))c.via.push(tag);
    if(!known)fresh.add(h)}
  for(const h of fresh){
    const why=gate(brief,s.cand[h]);
    if(why){s.seen[h]='g';s.stats.gated++;s.reasons[why]=(s.reasons[why]||0)+1;delete s.cand[h]}
    else{s.seen[h]='q';s.triageQ.push(h)}}
  return fresh.size}

/* Plain-code gate: instant, free, before any model sees a creator. */
export function gate(brief,c){
  if(c.priv)return 'private account';
  if(c.f&&c.f<brief.followers.min)return 'below follower band';
  if(c.f>brief.followers.max)return 'above follower band';
  const hay=(c.sig+' '+c.nick).toLowerCase();
  const neg=(brief._disq||[]).find(w=>w&&hay.includes(w.toLowerCase()));
  if(neg)return 'disqualifier: '+neg;
  return ''}

/* ── triage ─────────────────────────────────────────────────────────────── */
export const TRIAGE_SYS=`You are the first-pass filter of a creator-sourcing funnel for a brand. Thousands of TikTok creators pass through you; only plausible ones move on to a slow, careful vetting step that reads their latest videos.
Throw out ONLY clear no's: wrong niche entirely, a brand/shop/agency/fan/repost/compilation/meme page (not a real person creating their own content), kids or kid-focused content, adult/sexual content, or an explicit hard disqualifier from the brief. Keep anyone plausibly in the niche even if the bio is thin — a false "no" loses a great creator forever, a false "yes" only costs one extra review.
Answer only with the JSON asked for.`;

export function triagePrompt(brief,batch,s){
  const rows=batch.map(h=>{const c=s.cand[h]||{};
    return JSON.stringify({h:'@'+h,f:c.f,likes:c.hearts,vids:c.vids,bio:c.sig,name:c.nick,cap:c.cap.slice(0,3),lang:[...new Set(c.lang)].join('/'),found_in:c.via.slice(0,3).map(t=>'#'+t)})});
  return `BRIEF\n${briefText(brief)}\n\nCREATORS (one JSON per line)\n${rows.join('\n')}\n\nFor every creator return {"h","pass":true|false,"fit":0-100,"why":"≤8 words"}.\nJSON: {"results":[...]}`}

export function applyTriage(s,batch,out){
  const by={};(out&&out.results||[]).forEach(r=>{if(r&&r.h)by[cleanHandle(r.h)]=r});
  let passed=0;
  for(const h of batch){
    const r=by[h];
    if(!r){const c=s.cand[h];if(!c)continue;     // model skipped it: retry later, never lose it
      c.triTries=(c.triTries||0)+1;if(c.triTries<3)s.triageQ.push(h);else{s.seen[h]='x';delete s.cand[h]}continue}
    s.stats.triaged++;
    const fit=Number(r.fit)||0;
    if(r.pass!==false&&fit>=45){s.seen[h]='p';s.fetchQ.push(h);s.stats.triagePassed++;passed++;
      (s.cand[h].via||[]).forEach(t=>{if(s.tags[t])s.tags[t].passed++});s.cand[h].tri={fit,why:String(r.why||'').slice(0,80)}}
    else{s.seen[h]='x';const k='triage: '+String(r.why||'not a fit').toLowerCase().slice(0,40);s.reasons[k]=(s.reasons[k]||0)+1;delete s.cand[h]}}
  return passed}

/* ── dossier: profile SSR + creator embed + a few video pages ───────────── */
export function parseProfileHtml(html){
  const m=String(html||'').match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
  if(!m)return null;
  try{const ui=JSON.parse(m[1]).__DEFAULT_SCOPE__['webapp.user-detail'].userInfo;if(!ui||!ui.user||!ui.user.uniqueId)return null;
    const u=ui.user,st=ui.stats||ui.statsV2||{};
    return {handle:cleanHandle(u.uniqueId),nick:u.nickname||'',bio:u.signature||'',bioLink:(u.bioLink&&u.bioLink.link)||'',
      lang:u.language||'',ver:!!u.verified,priv:!!u.privateAccount,avatar:u.avatarMedium||u.avatarThumb||'',
      org:!!u.isOrganization,commerce:!!(u.commerceUserInfo&&u.commerceUserInfo.commerceUser),
      f:Number(st.followerCount)||0,hearts:Number(st.heartCount||st.heart)||0,vids:Number(st.videoCount)||0,following:Number(st.followingCount)||0,
      createdAt:u.createTime?Number(u.createTime)*1000:0}}catch(e){return null}}

export function parseEmbedHtml(html,handle){
  const m=String(html||'').match(/<script[^>]*id="__FRONTITY_CONNECT_STATE__"[^>]*>([\s\S]*?)<\/script>/);
  if(!m)return null;
  try{const d=JSON.parse(m[1]).source.data;const key=Object.keys(d).find(k=>/^\/embed\/@/.test(k));const node=d[key];
    if(!node||!Array.isArray(node.videoList))return null;
    const u=node.userInfo||{};
    return {user:{f:Number(u.followerCount)||0,hearts:Number(u.heartCount)||0,bio:u.signature||'',nick:u.nickname||'',ver:!!u.verified,priv:!!u.privateAccount,avatar:u.avatarThumbUrl||''},
      videos:node.videoList.map(v=>({id:String(v.id),desc:String(v.desc||'').replace(/\s+/g,' ').slice(0,220),views:Number(v.playCount)||0,at:idToTime(v.id)}))}}catch(e){return null}}

export function parseVideoHtml(html){
  const m=String(html||'').match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
  if(!m)return null;
  try{const it=JSON.parse(m[1]).__DEFAULT_SCOPE__['webapp.video-detail'].itemInfo.itemStruct;const s=it.stats||{};
    return {id:String(it.id),views:Number(s.playCount)||0,likes:Number(s.diggCount)||0,comments:Number(s.commentCount)||0,shares:Number(s.shareCount)||0,saves:Number(s.collectCount)||0,
      ad:!!(it.isAd||it.brandOrganicType||(it.anchors&&it.anchors.length&&0)),
      tags:(it.textExtra||[]).map(x=>x.hashtagName).filter(Boolean).map(cleanTag),
      mentions:(it.textExtra||[]).map(x=>x.userUniqueId).filter(Boolean).map(cleanHandle),
      music:it.music&&it.music.title||''}}catch(e){return null}}

/* Real metrics from what the dossier fetched. Pinned videos (the first ones
   the embed lists, often far older) are kept apart so they don't skew
   recency or the median. */
export function metrics(prof,emb,vpages,now){
  now=now||Date.now();
  const vids=(emb&&emb.videos)||[];
  // pinned = leading videos older than the newest non-leading one
  let pinned=0;const times=vids.map(v=>v.at);
  for(let i=0;i<Math.min(3,vids.length);i++){const rest=times.slice(i+1);if(rest.length&&times[i]<Math.max(...rest))pinned=i+1;else break}
  const recent=vids.slice(pinned).sort((a,b)=>b.at-a.at);
  const views=recent.map(v=>v.views);
  const med=median(views);
  const last=recent[0]?recent[0].at:0;
  const span=recent.length>1?(recent[0].at-recent[recent.length-1].at)/86400000:0;
  const ppw=recent.length>1&&span>0?+((recent.length-1)/span*7).toFixed(1):0;
  const eng=(vpages||[]).filter(v=>v&&v.views>0);
  const er=eng.length?+(eng.reduce((a,v)=>a+(v.likes+v.comments+v.shares)/v.views,0)/eng.length*100).toFixed(2):null;
  const f=(prof&&prof.f)||(emb&&emb.user.f)||0;
  return {followers:f,medViews:med,avgViews:views.length?Math.round(views.reduce((a,b)=>a+b,0)/views.length):0,
    viewsToFollowers:f?+(med/f).toFixed(2):null,engagementRate:er,postsPerWeek:ppw,
    lastPostDays:last?Math.floor((now-last)/86400000):null,sampled:recent.length,pinned,
    likesPerVideo:prof&&prof.vids?Math.round(prof.hearts/prof.vids):null,
    sponsoredShare:eng.length?+(eng.filter(v=>v.ad).length/eng.length).toFixed(2):0}}

/* Second plain-code gate, now on real numbers. */
export function dossierGate(brief,d){
  const m=d.m;
  if(d.priv)return 'private account';
  if(m.followers&&(m.followers<brief.followers.min||m.followers>brief.followers.max))return 'outside follower band';
  if(m.lastPostDays!=null&&m.lastPostDays>brief.max_inactive_days)return 'inactive';
  if(brief.min_median_views&&m.medViews<brief.min_median_views)return 'views too low';
  if(d.org)return 'organisation account';
  return ''}

export function buildDossier(handle,cand,prof,emb,vpages,now){
  const m=metrics(prof,emb,vpages,now);
  const vids=(emb&&emb.videos)||[];
  const recent=vids.slice(m.pinned).sort((a,b)=>b.at-a.at);
  return {handle,nick:(prof&&prof.nick)||(cand&&cand.nick)||'',bio:(prof&&prof.bio)||(emb&&emb.user.bio)||(cand&&cand.sig)||'',
    bioLink:(prof&&prof.bioLink)||'',lang:(prof&&prof.lang)||'',ver:!!(prof&&prof.ver),priv:!!((prof&&prof.priv)||(emb&&emb.user.priv)),
    org:!!(prof&&prof.org),avatar:(prof&&prof.avatar)||(cand&&cand.avatar)||'',hearts:(prof&&prof.hearts)||0,vids:(prof&&prof.vids)||0,
    m,videos:recent.slice(0,10).map(v=>({id:v.id,desc:v.desc,views:v.views,daysAgo:Math.floor(((now||Date.now())-v.at)/86400000)})),
    pinnedVideos:vids.slice(0,m.pinned).map(v=>({id:v.id,desc:v.desc,views:v.views})),
    tags:[...new Set((vpages||[]).flatMap(v=>v?v.tags:[]).concat(recent.flatMap(v=>(v.desc.match(/#[\p{L}\p{N}_]+/gu)||[]).map(cleanTag))))].slice(0,40),
    mentions:[...new Set((vpages||[]).flatMap(v=>v?v.mentions:[]))].filter(x=>x&&x!==handle).slice(0,20),
    via:(cand&&cand.via)||[],triage:(cand&&cand.tri)||null}}

/* ── vetting ────────────────────────────────────────────────────────────── */
export const VET_SYS=`You are a senior influencer-marketing analyst vetting TikTok creators for a brand partnership. Your recommendation decides who the brand contacts, so be rigorous, evidence-based and fair.
You receive the brand brief and, per creator, a dossier: bio, bio link, real metrics (median views on the latest videos, engagement rate, posting frequency, days since last post) and the captions of their latest videos.
Judge ONLY on what the dossier actually shows — never on the hashtag they were found under.
Criteria, in order:
1. Niche fit: do their recent videos concretely and consistently show the brief's activity/topic? A creator who only occasionally touches it is not a fit.
2. Values & brand safety: anything in captions/bio that contradicts the brief's values or hard disqualifiers (e.g. doping/steroid promotion, gambling, alcohol, hate, sexualised content, drama/controversy baiting, scams, dangerous stunts, crude humiliation) → reject. When the brief lists values, they must be visibly present, not merely not-contradicted.
3. Is it a real individual creating original content (not a repost/fan/clip/compilation page, not a brand or shop)?
4. Audience & market: language and likely audience match the brief.
5. Performance: median views vs followers, engagement, consistency. Strong niche fit with modest reach is still valuable; dead or bought-looking audiences are not.
6. Partnership potential: authenticity, how naturally the brand's product would fit their content, current sponsor clutter.
verdict: "accept" (you would confidently recommend contacting them), "maybe" (plausible but evidence is thin or mixed), "reject".
score 0–100 must be consistent with verdict (accept ≥ 70, reject < 55).
Answer only with the JSON asked for.`;

export function vetPrompt(brief,dossiers){
  const rows=dossiers.map(d=>JSON.stringify({h:'@'+d.handle,name:d.nick,bio:d.bio.slice(0,300),link:d.bioLink,lang:d.lang,verified:d.ver,
    followers:d.m.followers,total_likes:d.hearts,videos_total:d.vids,median_views:d.m.medViews,views_to_followers:d.m.viewsToFollowers,
    engagement_rate_pct:d.m.engagementRate,posts_per_week:d.m.postsPerWeek,days_since_last_post:d.m.lastPostDays,sponsored_share:d.m.sponsoredShare,
    latest:d.videos.slice(0,10).map(v=>`[${v.daysAgo}d · ${v.views} views] ${v.desc}`),pinned:d.pinnedVideos.map(v=>v.desc).slice(0,3)}));
  const lang=brief.summary_language||'en';
  return `BRIEF\n${briefText(brief)}\n\nDOSSIERS (one JSON per line)\n${rows.join('\n')}\n\nFor every creator return:
{"h","verdict":"accept|maybe|reject","score":0-100,"niche":"1-4 words, what they ACTUALLY post","fit":"why, citing concrete evidence (≤30 words)","safety":"clean|caution|risk","safety_notes":"≤20 words or empty","flags":[],"audience":"≤12 words","style":"≤12 words, content format/tone","collab":"≤20 words, how the brand could naturally work with them","summary":"2 sentences for the brand, written in language code '${lang}'"}
flags from: brand, repost, wrong_niche, values_mismatch, brand_safety, inactive, low_engagement, wrong_market, kids, adult, heavy_sponsoring.
JSON: {"results":[...]}`}

export function readVerdict(r,brief){
  const score=Math.max(0,Math.min(100,Math.round(Number(r.score)||0)));
  const safety=['clean','caution','risk'].includes(r.safety)?r.safety:'caution';
  const flags=(Array.isArray(r.flags)?r.flags:[]).map(String).slice(0,8);
  const hard=flags.some(f=>/brand|repost|values_mismatch|brand_safety|kids|adult/.test(f));
  const verdict=['accept','maybe','reject'].includes(r.verdict)?r.verdict:'maybe';
  const accept=verdict==='accept'&&score>=brief.min_score&&safety!=='risk'&&!hard;
  return {score,safety,flags,verdict,accept,hard,
    niche:String(r.niche||'').slice(0,50),fit:String(r.fit||'').slice(0,260),safetyNotes:String(r.safety_notes||'').slice(0,200),
    audience:String(r.audience||'').slice(0,120),style:String(r.style||'').slice(0,120),collab:String(r.collab||'').slice(0,200),summary:String(r.summary||'').slice(0,500)}}

/* Balanced mode: the cheap reviewer decides the clear cases; anything in the
   grey zone gets a second, slower read before it can reach the list. */
export function needsEscalation(v,brief,tier){
  if(tier!=='haiku')return false;
  if(v.hard||v.safety==='risk')return false;
  if(v.verdict==='reject'&&v.score<50)return false;
  if(v.accept&&v.score>=brief.min_score+10&&v.safety==='clean')return false;
  return v.score>=50}

/* ── contacts ───────────────────────────────────────────────────────────── */
export function extractEmails(text){
  const norm=e=>{let x=e.replace(/\(dot\)|\[dot\]|\s+dot\s+/gi,'.');
    x=x.includes('@')?x:x.replace(/\s*(?:\(at\)|\[at\]|\sat\s)\s*/i,'@');
    return x.replace(/\s+/g,'').toLowerCase()};
  return [...new Set((String(text||'').match(EMAIL_RE)||[]).map(norm).filter(e=>/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(e)&&!BAD_EMAIL.test(e)))].slice(0,3)}

export function extractLinks(html){
  const out={instagram:'',youtube:'',x:'',website:'',emails:[]};
  const hrefs=[...String(html||'').matchAll(/href="([^"]+)"/g)].map(m=>m[1].replace(/&amp;/g,'&'));
  for(const u of hrefs){
    if(u.startsWith('mailto:')){const e=decodeURIComponent(u.slice(7).split('?')[0]).toLowerCase();if(/@/.test(e)&&!BAD_EMAIL.test(e))out.emails.push(e);continue}
    const ig=u.match(/instagram\.com\/([A-Za-z0-9._]{2,30})/);if(ig&&!out.instagram&&!/^(p|reel|explore|accounts)$/.test(ig[1]))out.instagram='@'+ig[1];
    const yt=u.match(/youtube\.com\/(@[A-Za-z0-9._-]{2,40}|c\/[^/?"]+|channel\/[A-Za-z0-9_-]+)/);if(yt&&!out.youtube)out.youtube='https://youtube.com/'+yt[1];
    const x=u.match(/(?:twitter|x)\.com\/([A-Za-z0-9_]{2,20})(?:[/?]|$)/);if(x&&!out.x&&!/^(intent|share|home)$/.test(x[1]))out.x='@'+x[1]}
  out.emails=[...new Set(out.emails.concat(extractEmails(html)))].slice(0,3);
  return out}

export function contactsFrom(d,linkPage){
  const bioEmails=extractEmails(d.bio);
  const lp=linkPage?extractLinks(linkPage):{instagram:'',youtube:'',x:'',website:'',emails:[]};
  const ig=(d.bio.match(/(?:ig|insta(?:gram)?)\s*[:\-–]?\s*@?([A-Za-z0-9._]{3,30})/i)||[])[1];
  const email=bioEmails[0]||lp.emails[0]||'';
  return {email,emailSource:bioEmails[0]?'bio':lp.emails[0]?'bio link':'',
    otherEmails:[...new Set(bioEmails.concat(lp.emails))].filter(e=>e!==email).slice(0,2),
    instagram:lp.instagram||(ig?'@'+ig:''),youtube:lp.youtube,x:lp.x,link:d.bioLink||''}}

/* ── the record the brand sees ──────────────────────────────────────────── */
export function resultRecord(d,v,contacts,tier){
  return {handle:d.handle,name:d.nick,url:'https://www.tiktok.com/@'+d.handle,avatar:d.avatar,verified:d.ver,lang:d.lang,
    followers:d.m.followers,hearts:d.hearts,videos:d.vids,medViews:d.m.medViews,avgViews:d.m.avgViews,viewsToFollowers:d.m.viewsToFollowers,
    engagementRate:d.m.engagementRate,postsPerWeek:d.m.postsPerWeek,lastPostDays:d.m.lastPostDays,sponsoredShare:d.m.sponsoredShare,
    bio:d.bio.slice(0,400),contacts,
    score:v.score,verdict:v.verdict,niche:v.niche,fit:v.fit,safety:v.safety,safetyNotes:v.safetyNotes,flags:v.flags,
    audience:v.audience,style:v.style,collab:v.collab,summary:v.summary,reviewedBy:tier,
    topVideos:[...d.videos].sort((a,b)=>b.views-a.views).slice(0,3).map(x=>({url:`https://www.tiktok.com/@${d.handle}/video/${x.id}`,views:x.views,desc:x.desc.slice(0,140)})),
    foundVia:d.via.slice(0,5),at:new Date().toISOString()}}

/* After an acceptance: its own hashtags and the creators it tags feed discovery. */
export function learnFromAccepted(s,d){
  (d.via||[]).forEach(t=>{if(s.tags[t])s.tags[t].acc++});
  d.tags.forEach(t=>{if(t&&!s.tags[t])s.hashCo[t]=(s.hashCo[t]||0)+1});
  d.mentions.forEach(h=>{if(h&&!s.seen[h]){s.mentions[h]=(s.mentions[h]||0)+1;
    if(s.mentions[h]===1){s.seen[h]='m';s.probeQ.push(h)}}})}

/* ── supervisor ─────────────────────────────────────────────────────────── */
export const SUP_SYS=`You supervise an autonomous creator-research run for a brand. You see how each hashtag is performing (how many of its authors survived triage and final vetting), which hashtags the ACCEPTED creators themselves use, and why candidates get rejected. Steer the search toward where the right creators actually are: propose new hashtags (niche, mid and long-tail, in every market language, including community slang and sub-niches the accepted creators use), and name hashtags to stop exploring. Avoid generic mega-tags (#fyp, #viral, #foryou) and brand names. Answer only with the JSON asked for.`;

export function supervisorPrompt(s,brief,target){
  const done=Object.entries(s.tags).filter(([,v])=>v.st==='done'&&v.authors);
  const perf=done.map(([t,v])=>({t,authors:v.authors,passed:v.passed,acc:v.acc,y:v.authors?(v.acc*3+v.passed)/v.authors:0})).sort((a,b)=>b.y-a.y);
  const top=perf.slice(0,25).map(x=>`#${x.t} authors=${x.authors} triage_pass=${x.passed} accepted=${x.acc}`);
  const bottom=perf.slice(-12).map(x=>`#${x.t} authors=${x.authors} triage_pass=${x.passed} accepted=${x.acc}`);
  const co=Object.entries(s.hashCo).sort((a,b)=>b[1]-a[1]).slice(0,70).map(([t,n])=>`#${t}(${n})`);
  const reasons=Object.entries(s.reasons).sort((a,b)=>b[1]-a[1]).slice(0,12).map(([r,n])=>`${r}: ${n}`);
  const todo=Object.entries(s.tags).filter(([,v])=>v.st==='todo').length;
  return `BRIEF\n${briefText(brief)}\n\nPROGRESS: ${s.stats.accepted} accepted of ${target} wanted · ${s.stats.tagsDone} hashtags explored · ${todo} still queued · ${s.stats.authorsSeen} creators seen.
BEST HASHTAGS SO FAR\n${top.join('\n')||'(none yet)'}\nWEAKEST\n${bottom.join('\n')||'(none yet)'}
HASHTAGS USED BY ACCEPTED CREATORS (count)\n${co.join(' ')||'(none yet)'}
REJECTION REASONS\n${reasons.join('\n')||'(none yet)'}
Already explored or queued (do not repeat): ${Object.keys(s.tags).slice(-300).join(' ')}

Return {"add":[{"tag":"...","pri":1-100,"why":"≤8 words"}] (up to ${LIMITS.MAX_SNOWBALL_PER_STEP} NEW hashtags),"drop":["tags to stop"],"note":"one sentence for the brand on what you are changing and why, in language '${brief.summary_language}'"}`}

export function applySupervisor(s,out){
  const add=(out&&Array.isArray(out.add)?out.add:[]).slice(0,LIMITS.MAX_SNOWBALL_PER_STEP);
  const n=addTags(s,add.map(x=>({tag:x.tag,pri:Math.max(1,Math.min(100,Number(x.pri)||60))})),'supervisor');
  let dropped=0;(out&&Array.isArray(out.drop)?out.drop:[]).forEach(t=>{const k=cleanTag(t);if(s.tags[k]&&s.tags[k].st==='todo'){s.tags[k].st='dropped';dropped++}});
  s.tagsSinceSupervise=0;s.supervisions++;
  const note=String(out&&out.note||'').slice(0,300);if(note)s.notes.push(note);
  return {added:n,dropped,note}}

/* ── plan ───────────────────────────────────────────────────────────────── */
export const PLAN_SYS=`You plan TikTok creator research for brands. You know how TikTok hashtags work: mega tags (#fitness) are noisy and dominated by huge accounts; mid tags (#gymtok, #legday) and long-tail/community tags (#naturalbodybuilding, #prepcoach, #musculationfemme) are where real, mid-size creators live. You think in every market language and in the community's own slang. Answer only with the JSON asked for.`;

export function planPrompt(brief){
  return `BRIEF\n${briefText(brief)}\n\nPlan the research.
- "hashtags": 90–140 hashtags, lowercase, no #, no spaces, no brand names, spread ~10% head / 45% mid / 45% long-tail, covering every sub-niche, format (tutorials, routines, transformations, vlogs, coaching, competitions…) and market language in the brief. Each {"tag","pri":1-100} — pri = how likely its authors are exactly the brief's creators.
- "disqualifiers": up to 25 lowercase words/short phrases that, if present in a bio or name, prove a creator is NOT a fit (e.g. shop, official, clips, fanpage, compilation, onlyfans...), tailored to this brief.
- "persona": one sentence describing the ideal creator.
JSON: {"hashtags":[...],"disqualifiers":[...],"persona":"..."}`}

export function applyPlan(s,brief,out){
  const n=addTags(s,(out&&out.hashtags)||[],'plan',60);
  brief._disq=[...new Set((out&&out.disqualifiers||[]).map(x=>String(x).toLowerCase().trim()).filter(x=>x.length>2))].slice(0,25);
  s.disq=brief._disq;s.persona=String(out&&out.persona||'').slice(0,300);s.planned=true;
  return n}

/* ── helpers for the loop ───────────────────────────────────────────────── */
export function parseJSON(text){
  const t=String(text||'');const a=t.indexOf('{'),b=t.lastIndexOf('}');
  if(a<0||b<=a)throw new Error('no JSON in model answer');
  return JSON.parse(t.slice(a,b+1))}

// $ per 1M tokens (input, output) — for the progress panel only
export const PRICE={haiku:[1,5],sonnet:[3,15]};
export function meter(s,tier,usage){
  if(!usage)return;const p=PRICE[tier]||PRICE.sonnet;
  const inT=(usage.input_tokens||0)+(usage.cache_creation_input_tokens||0),cached=usage.cache_read_input_tokens||0,outT=usage.output_tokens||0;
  s.stats.tokensIn+=inT+cached;s.stats.tokensOut+=outT;
  s.stats.costUsd=+(s.stats.costUsd+(inT*p[0]+cached*p[0]*0.1+outT*p[1])/1e6).toFixed(4)}

/* A session that died mid-batch leaves creators out of every queue: put them
   back where they belong so nothing is ever silently lost. */
export function repairQueues(s){
  const inQ=new Set([...s.triageQ,...s.fetchQ,...s.deepQ,...s.escalateQ,...s.probeQ]);let n=0;
  for(const [h,c] of Object.entries(s.cand)){if(inQ.has(h))continue;
    if(s.seen[h]==='q'){s.triageQ.push(h);n++}else if(s.seen[h]==='p'){s.fetchQ.push(h);n++}}
  for(const h of Object.keys(s.dossiers)){if(!inQ.has(h)){s.deepQ.push(h);n++}}
  for(const [h,st] of Object.entries(s.seen)){if(st==='m'&&!inQ.has(h)&&!s.cand[h]){s.probeQ.push(h);n++}}
  return n}

export function isExhausted(s){
  return !nextTag(s)&&!s.triageQ.length&&!s.fetchQ.length&&!s.deepQ.length&&!s.escalateQ.length&&!s.probeQ.length}
