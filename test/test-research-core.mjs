// Deep research — pure funnel logic. node test/test-research-core.mjs
import * as C from '../harvest/research-core.mjs';
let pass=0,fail=0;const out=[];
const ok=(c,m)=>{if(c){pass++;out.push('  ✓ '+m)}else{fail++;out.push('  ✗ '+m)}};
const DAY=86400000,NOW=Date.parse('2026-09-29T12:00:00Z');
const tid=(ms,seq=1)=>((BigInt(Math.floor(ms/1000))<<32n)+BigInt(seq)).toString();

out.push('brief');
{const b=C.normBrief({brand:'Teveo',niche_summary:'gym women',followers:{min:10000},markets:'fr, de',languages:['FR'],target_count:99999,seed_hashtags:['#GymTok','musculation femme']});
 ok(b.followers.min===10000&&b.followers.max===1000000,'follower band defaults');
 ok(b.markets.join()==='FR,DE'&&b.languages.join()==='fr','markets/languages normalised');
 ok(b.target_count===20000,'target capped');
 ok(b.seed_hashtags.join()==='gymtok,musculationfemme','seed tags cleaned');
 ok(b.quality==='balanced'&&b.min_score===72&&b.max_cost_usd===800,'quality, bar and budget defaults');
 ok(/NEVER|MUST|Brand: Teveo/.test(C.briefText(b)),'brief rendered for prompts');}

out.push('discover + gate');
const brief=C.normBrief({brand:'Teveo',niche_summary:'bodybuilding',followers:{min:5000,max:500000},seed_hashtags:['gymtok'],target_count:100});
brief._disq=['clips','shop'];
const S=C.newState(brief);
ok(C.nextTag(S)==='gymtok','seed tag queued first');
const item=(h,f,extra)=>({id:h+Math.random(),desc:'leg day #gymtok',textLanguage:'en',stats:{playCount:5000},author:{uniqueId:h,signature:'coach',nickname:h,...(extra||{})},authorStats:{followerCount:f,heartCount:100000,videoCount:200}});
const n=C.ingestFeed(S,brief,'gymtok',[item('Alice',20000),item('alice',20000),item('bob',300),item('bigguy',2e6),item('fitclips',50000,{signature:'best clips daily'}),item('priv',30000,{privateAccount:true}),item('carl',80000)]);
ok(n===6,'6 distinct creators from 7 posts (same author folded)');
ok(S.triageQ.join()==='alice,carl','only in-band, public, non-disqualified creators reach triage');
ok(S.cand.alice.cap.length===2,'captions merged across posts');
ok(S.reasons['below follower band']===1&&S.reasons['disqualifier: clips']===1&&S.reasons['private account']===1,'gate reasons tallied');
ok(S.tags.gymtok.st==='done'&&S.tags.gymtok.authors===6&&S.stats.postsRead===7,'tag bookkeeping');
C.ingestFeed(S,brief,'legday',[item('alice',20000)]);
ok(S.triageQ.length===2&&S.cand.alice.via.join()==='gymtok,legday','a creator met again is not re-queued, but remembers where it was found');

out.push('triage');
{const p=C.triagePrompt(brief,['alice','carl'],S);
 ok(p.includes('"h":"@alice"')&&p.includes('found_in'),'prompt carries the creator rows');
 const batch=S.triageQ.splice(0);
 const passed=C.applyTriage(S,batch,{results:[{h:'@alice',pass:true,fit:80,why:'real lifter'}]});
 ok(passed===1&&S.fetchQ.join()==='alice'&&S.seen.alice==='p','pass → dossier queue');
 ok(S.triageQ.join()==='carl','a creator the model skipped goes back in line');
 C.applyTriage(S,['carl'],{results:[{h:'carl',pass:false,fit:20,why:'dance content'}]});
 ok(S.seen.carl==='x'&&!S.cand.carl,'clear no dropped');
 ok(S.tags.gymtok.passed===1,'tag credited for the pass');}

out.push('dossier parsing + metrics');
const profHtml=`<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({__DEFAULT_SCOPE__:{'webapp.user-detail':{userInfo:{user:{uniqueId:'alice',nickname:'Alice',signature:'IFBB pro | 📩 alice.fit@gmail.com',bioLink:{link:'https://linktr.ee/alice'},language:'en',verified:false,privateAccount:false},stats:{followerCount:20000,heartCount:900000,videoCount:300}}}}})}</script>`;
const vids=[{id:tid(NOW-400*DAY),desc:'pinned old',playCount:900000},...Array.from({length:10},(_,i)=>({id:tid(NOW-(1+i*2)*DAY,i),desc:`push day ${i} #gymtok #natty @bob`,playCount:10000+i*1000}))];
const embHtml=`<script id="__FRONTITY_CONNECT_STATE__" type="application/json">${JSON.stringify({source:{data:{'/embed/@alice':{userInfo:{followerCount:20000,heartCount:900000,signature:'x',privateAccount:false},videoList:vids}}}})}</script>`;
const vidHtml=`<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">${JSON.stringify({__DEFAULT_SCOPE__:{'webapp.video-detail':{itemInfo:{itemStruct:{id:'1',stats:{playCount:10000,diggCount:800,commentCount:100,shareCount:100,collectCount:50},textExtra:[{hashtagName:'Natty'},{userUniqueId:'dana'}]}}}}})}</script>`;
const prof=C.parseProfileHtml(profHtml),emb=C.parseEmbedHtml(embHtml,'alice'),vp=C.parseVideoHtml(vidHtml);
ok(prof&&prof.bioLink==='https://linktr.ee/alice'&&prof.f===20000,'profile SSR parsed');
ok(emb&&emb.videos.length===11&&emb.videos[1].at>0,'creator embed parsed, dates from video ids');
ok(vp&&vp.likes===800&&vp.tags.join()==='natty'&&vp.mentions.join()==='dana','video page parsed');
ok(C.parseProfileHtml('<html>captcha</html>')===null&&C.parseEmbedHtml('')===null,'garbage → null, never throws');
const m=C.metrics(prof,emb,[vp],NOW);
ok(m.pinned===1,'old pinned video detected and set apart');
ok(m.medViews===14500&&m.lastPostDays===1,'median and recency from the latest videos only ('+m.medViews+','+m.lastPostDays+')');
ok(m.postsPerWeek===3.5&&m.engagementRate===10,'posting rate and engagement ('+m.postsPerWeek+','+m.engagementRate+')');
const d=C.buildDossier('alice',S.cand.alice,prof,emb,[vp],NOW);
ok(d.videos.length===10&&d.videos[0].daysAgo===1&&d.pinnedVideos.length===1,'dossier keeps 10 latest, pinned apart');
ok(d.tags.includes('natty')&&d.mentions.join()==='dana','hashtags and mentions collected for the snowball');
ok(C.dossierGate(brief,d)==='','active, in-band creator passes the second gate');
ok(C.dossierGate(brief,{...d,m:{...d.m,lastPostDays:90}})==='inactive','inactive creator stopped before any model call');
ok(C.vetPrompt(brief,[d]).includes('median_views'),'vetting prompt carries real metrics');

out.push('verdicts');
{const v=C.readVerdict({verdict:'accept',score:88,safety:'clean',flags:[]},brief);
 ok(v.accept&&!C.needsEscalation(v,brief,'haiku'),'confident clean accept from the fast reviewer stands');
 const g=C.readVerdict({verdict:'accept',score:74,safety:'clean',flags:[]},brief);
 ok(g.accept&&C.needsEscalation(g,brief,'haiku'),'borderline accept escalated to Sonnet');
 ok(!C.needsEscalation(g,brief,'sonnet'),'Sonnet decides for good');
 const mb=C.readVerdict({verdict:'maybe',score:68,safety:'caution'},brief);
 ok(!mb.accept&&C.needsEscalation(mb,brief,'haiku'),'"maybe" gets a second opinion');
 const bad=C.readVerdict({verdict:'accept',score:90,safety:'clean',flags:['values_mismatch']},brief);
 ok(!bad.accept&&!C.needsEscalation(bad,brief,'haiku'),'a values mismatch can never be accepted, whatever the score');
 const risk=C.readVerdict({verdict:'accept',score:90,safety:'risk'},brief);
 ok(!risk.accept,'brand-safety risk never accepted');}

out.push('contacts');
{ok(C.extractEmails('biz: kate.fit@gmail.com').join()==='kate.fit@gmail.com','plain email kept intact');
 ok(C.extractEmails('contact: coach (at) gmail (dot) com').join()==='coach@gmail.com','obfuscated email decoded');
 ok(C.extractEmails('logo@2x.png sentry@wixpress.com').length===0,'junk addresses ignored');
 const l=C.extractLinks('<a href="mailto:Team@Alice.com?subject=x">m</a><a href="https://instagram.com/alice.lifts">ig</a><a href="https://www.youtube.com/@AliceLifts">yt</a>');
 ok(l.emails[0]==='team@alice.com'&&l.instagram==='@alice.lifts'&&l.youtube==='https://youtube.com/@AliceLifts','bio-link page → email, Instagram, YouTube');
 const c=C.contactsFrom(d,'<a href="mailto:mgmt@agency.com">x</a>');
 ok(c.email==='alice.fit@gmail.com'&&c.emailSource==='bio'&&c.otherEmails[0]==='mgmt@agency.com','bio email preferred, link-page email kept as a second contact');}

out.push('snowball + supervisor');
{C.learnFromAccepted(S,d);
 ok(S.hashCo.natty===1&&S.probeQ.includes('dana')&&S.seen.dana==='m','accepted creator seeds new hashtags and the creators it tags');
 const r=C.applySupervisor(S,{add:[{tag:'#NattyLifter',pri:90},{tag:'gymtok'}],drop:['legday'],note:'Shift to natural lifting'});
 ok(r.added===1&&S.tags.nattylifter.pri===90,'new hashtags added, known ones not duplicated');
 ok(C.nextTag(S)==='nattylifter','highest-priority tag explored next');
 ok(S.notes.includes('Shift to natural lifting'),'supervisor note kept for the brand');
 ok(C.supervisorPrompt(S,brief,100).includes('HASHTAGS USED BY ACCEPTED CREATORS'),'supervisor sees what accepted creators use');
 const p=C.applyPlan(S,brief,{hashtags:[{tag:'prepcoach',pri:70},'musculation'],disqualifiers:['onlyfans'],persona:'x'});
 ok(p===2&&brief._disq.includes('onlyfans')&&S.planned,'plan applied');}

out.push('resilience');
{const s2=C.newState(brief);s2.cand.z={via:[]};s2.seen.z='q';s2.dossiers.y={handle:'y'};s2.seen.w='m';
 ok(C.repairQueues(s2)===3&&s2.triageQ.includes('z')&&s2.deepQ.includes('y')&&s2.probeQ.includes('w'),'in-flight creators recovered after a crash');
 const s3=C.newState(C.normBrief({niche_summary:'x'}));
 ok(C.isExhausted(s3),'empty state is exhausted');
 const u={input_tokens:1000000,output_tokens:100000};C.meter(s3,'haiku',u);
 ok(s3.stats.costUsd===1.5,'cost metered per tier ($'+s3.stats.costUsd+')');
 ok(C.extractLinks('<a href="https://instagram.com/hts">x</a><a href="https://www.instagram.com/alice.lifts/">y</a>').instagram==='@alice.lifts','junk Instagram paths ignored');
 ok(C.parseJSON('noise {"a":1} tail').a===1,'JSON extracted from a chatty answer');}

console.log(out.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
if(fail)process.exit(1);
