
/* ═══ DEEP RESEARCH — the brand talks to an AI strategist, then an
   autonomous worker searches TikTok for as long as it takes ═══════════════
   1. BRIEF CHAT   Sonnet interviews the brand (niche, values, exclusions,
                   audience, markets, size, contacts, examples) and writes a
                   structured brief the brand can review and edit.
   2. LAUNCH       POST /api/research?op=create — the job lives in Redis, not
                   in this tab. A worker on GitHub Actions (free, headless
                   Chromium + plain HTTP on public TikTok pages — no paid
                   scraper) claims it and runs for hours, checkpointing, and
                   resumes by itself across sessions.
   3. WATCH        progress, funnel numbers, the supervisor's strategy notes
                   and the live log, polled from /api/research?op=job.
   4. RESULTS      every accepted creator with real metrics, a score, the
                   reasons, brand-safety notes, collaboration ideas and
                   contacts — filter, export CSV, save to Lists.
   ═════════════════════════════════════════════════════════════════════ */
AGENTS.rsInterview={name:'Research strategist',role:'Interviews the brand and writes the creator-research brief',
  system:`You are Cadence's creator-research strategist. A brand is about to launch an autonomous, deep search for TikTok creators to partner with. Your job is to understand EXACTLY who they need, then write the research brief.
How to work:
- Reply in the language the brand writes in. Be warm, concise and expert.
- Interview efficiently: ask at most 3–4 focused questions per message, prioritising what changes the search most: brand & product; campaign goal and content type wanted; the creator profile (niche, sub-niches, content style, level — beginner/intermediate/pro); values the creator must embody and hard exclusions (things the brand will never be associated with); target audience (gender, age); markets/countries and languages; follower range; how many creators they want; whether a public contact (email) is required; creators they already like (TikTok handles) as references.
- Suggest smart defaults and concrete examples from your knowledge of TikTok so the brand only has to confirm or adjust.
- After 1–3 rounds (or immediately if the brand asks to launch), write a short recap followed by the brief in a fenced block exactly like:
\`\`\`brief
{"title":"short name","brand":"","product":"","goal":"","niche_summary":"2-4 sentences: who exactly we want","persona":"one sentence","must_have":[],"nice_to_have":[],"exclude":[],"values":[],"tone":"","audience":"","markets":["FR"],"languages":["fr"],"followers":{"min":10000,"max":500000},"target_count":500,"min_score":72,"max_inactive_days":45,"contact_required":false,"example_creators":[],"seed_hashtags":[],"quality":"balanced","summary_language":"fr"}
\`\`\`
- seed_hashtags: 15–30 of your best hashtags for this niche, in every market language, without #.
- If the brand later asks for changes, output the full updated brief block again.`};

const RS={jobs:[],open:null,job:null,results:{},poll:null,loading:false,filter:{min:0,email:false,clean:false,q:'',sort:'score'},shown:150,sending:false};
function rsCfg(){if(!db.rs)db.rs={chat:[],brief:null};return db.rs}

/* ── chat ─────────────────────────────────────────────────────────────── */
function rsExtractBrief(text){
  const m=String(text||'').match(/```brief\s*([\s\S]*?)```/);if(!m)return null;
  try{return JSON.parse(m[1])}catch(e){return null}}
const rsStripBrief=t=>String(t||'').replace(/```brief[\s\S]*?```/,'').trim();

async function rsSend(){
  const c=rsCfg(),inp=$('rs-in');if(!inp||RS.sending)return;
  const text=inp.value.trim();if(!text)return;
  c.chat.push({role:'user',content:text});inp.value='';RS.sending=true;save();rsRenderChat();
  try{
    const j=await claudeCall({max_tokens:2200,system:sys(AGENTS.rsInterview.system),
      messages:c.chat.slice(-24).map(m=>({role:m.role,content:m.content}))},'sonnet');
    const reply=textOf(j)||'…';
    c.chat.push({role:'assistant',content:reply});
    const b=rsExtractBrief(reply);if(b){c.brief=b}
  }catch(e){c.chat.push({role:'assistant',content:'⚠︎ '+e.message,err:true})}
  RS.sending=false;save();rsRenderChat();rsRenderBrief()}

function rsResetChat(){const c=rsCfg();if(c.chat.length&&typeof confirm==='function'&&!confirm('Start a new brief? The current conversation will be cleared.'))return;
  c.chat=[];c.brief=null;save();rsRenderChat();rsRenderBrief()}

function rsMd(t){return esc(t).replace(/\*\*(.+?)\*\*/g,'<b>$1</b>').replace(/\n/g,'<br>')}
function rsRenderChat(){
  const el=$('rs-chat');if(!el)return;const c=rsCfg();
  const msgs=c.chat.length?c.chat:[{role:'assistant',content:"Hi! Tell me about your brand and the creators you'd love to work with — I'll ask a few questions, then launch a deep search that vets every creator one by one.\n\nSalut ! Parlez-moi de votre marque et des créateurs avec qui vous aimeriez collaborer — je vous poserai quelques questions, puis je lancerai une recherche approfondie qui analyse chaque créateur un par un."}];
  el.innerHTML=msgs.map(m=>{const me=m.role==='user';const txt=me?m.content:rsStripBrief(m.content)+(rsExtractBrief(m.content)?'\n\n📋 Brief ready — review it below.':'');
    return `<div style="display:flex;justify-content:${me?'flex-end':'flex-start'};margin:8px 0">
      <div style="max-width:82%;padding:10px 13px;border-radius:12px;line-height:1.5;font-size:14px;${me?'background:var(--rust);color:#fff':'background:var(--white);border:1px solid var(--line)'}${m.err?';color:var(--rust-d)':''}">${rsMd(txt)}</div></div>`}).join('')
    +(RS.sending?`<div class="hd" style="margin:6px 2px"><span class="spin"></span> thinking…</div>`:'');
  el.scrollTop=el.scrollHeight}

/* ── brief card ───────────────────────────────────────────────────────── */
function rsRenderBrief(){
  const el=$('rs-brief');if(!el)return;const b=rsCfg().brief;
  if(!b){el.innerHTML='';return}
  const f=b.followers||{};const list=a=>(Array.isArray(a)?a:[]).join(', ');
  el.innerHTML=`<div class="panel" style="padding:16px 18px;margin-top:12px">
    <div class="sh"><b style="font-weight:500">Research brief · ${esc(b.title||b.brand||'')}</b><span class="hd">edit anything, then launch</span></div>
    <div class="fg"><label>Who we want</label><textarea id="rsb-niche" style="min-height:70px">${esc(b.niche_summary||'')}</textarea></div>
    <div class="fl">
      <div class="fg"><label>Must have</label><input id="rsb-must" value="${esc(list(b.must_have))}"></div>
      <div class="fg"><label>Never (hard exclusions)</label><input id="rsb-excl" value="${esc(list(b.exclude))}"></div>
      <div class="fg"><label>Values</label><input id="rsb-val" value="${esc(list(b.values))}"></div>
      <div class="fg"><label>Markets · languages</label><input id="rsb-mk" value="${esc(list(b.markets))} · ${esc(list(b.languages))}"></div>
    </div>
    <div class="fl">
      <div class="fg"><label>Min followers</label><input id="rsb-min" value="${num(f.min||10000)}"></div>
      <div class="fg"><label>Max followers</label><input id="rsb-max" value="${num(f.max||500000)}"></div>
      <div class="fg"><label>How many creators</label><input id="rsb-n" value="${num(b.target_count||500)}"></div>
      <div class="fg"><label>Review depth</label><select id="rsb-q">
        <option value="balanced" ${b.quality!=='max'?'selected':''}>Balanced — fast review, Sonnet re-reads every borderline case</option>
        <option value="max" ${b.quality==='max'?'selected':''}>Maximum — Sonnet reads every candidate</option></select></div>
    </div>
    <div class="fl">
      <div class="fg"><label>Quality bar (score /100)</label><input id="rsb-score" value="${esc(String(b.min_score||72))}"></div>
      <div class="fg"><label>Max AI budget ($)</label><input id="rsb-budget" value="${esc(String(b.max_cost_usd||Math.max(10,Math.round((b.target_count||500)*0.04))))}"></div>
      <div class="fg"><label>Contact required</label><select id="rsb-contact"><option value="0" ${!b.contact_required?'selected':''}>No — keep great creators without a public email</option><option value="1" ${b.contact_required?'selected':''}>Yes — only creators with an email or Instagram</option></select></div>
      <div class="fg"><label>Reference creators</label><input id="rsb-ex" value="${esc(list(b.example_creators))}"></div>
    </div>
    <details style="margin-bottom:12px"><summary class="hd" style="cursor:pointer">Full brief (JSON)</summary><textarea id="rsb-json" style="min-height:160px;font-family:monospace;font-size:12px">${esc(JSON.stringify(b,null,2))}</textarea></details>
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
      <span class="hd">No paid scraper: public TikTok pages only. AI cost is metered live and capped by the budget above (≈$0.02–0.05 per accepted creator). It runs in the cloud — you can close this tab.</span>
      <button class="btn p" onclick="rsLaunch(this)">Launch deep research</button></div></div>`}

function rsReadBrief(){
  let b={...(rsCfg().brief||{})};
  const js=$('rsb-json');if(js){try{b={...b,...JSON.parse(js.value)}}catch(e){}}
  const arr=v=>String(v||'').split(',').map(x=>x.trim()).filter(Boolean);
  const n=v=>+String(v||'').replace(/[^0-9.]/g,'')||0;
  b.niche_summary=$('rsb-niche').value.trim();
  b.must_have=arr($('rsb-must').value);b.exclude=arr($('rsb-excl').value);b.values=arr($('rsb-val').value);
  const [mk,lg]=$('rsb-mk').value.split('·');b.markets=arr(mk).map(x=>x.toUpperCase());b.languages=arr(lg).map(x=>x.toLowerCase());
  b.followers={min:n($('rsb-min').value),max:n($('rsb-max').value)};
  b.target_count=n($('rsb-n').value)||500;b.quality=$('rsb-q').value;
  b.min_score=n($('rsb-score').value)||72;b.max_cost_usd=n($('rsb-budget').value)||undefined;
  b.contact_required=$('rsb-contact').value==='1';b.example_creators=arr($('rsb-ex').value);
  return b}

async function rsLaunch(btn){
  const b=rsReadBrief();if(!b.niche_summary){alert('Describe who you want first.');return}
  rsCfg().brief=b;save();
  btn.disabled=true;btn.innerHTML='<span class="spin"></span>Launching…';
  try{const r=await apiFetch('/api/research?op=create',{method:'POST',body:JSON.stringify({brief:b})});
    const j=await r.json();if(!r.ok)throw new Error(j.error&&j.error.message||('HTTP '+r.status));
    emit('research_started',{id:j.id,target:b.target_count});
    RS.open=j.id;RS.instant=j.instant;await rsLoadJobs();await rsOpen(j.id)}
  catch(e){alert('Could not launch: '+e.message);btn.disabled=false;btn.innerHTML='Launch deep research'}}

/* ── jobs ─────────────────────────────────────────────────────────────── */
async function rsLoadJobs(){
  try{const r=await apiFetch('/api/research?op=jobs',{method:'GET'});const j=await r.json();RS.jobs=j.jobs||[]}catch(e){RS.jobsErr=e.message}
  rsRenderJobs()}
const RS_ST={queued:['Waiting for the worker',''],running:['Searching','g'],cancel_requested:['Stopping…',''],cancelled:['Stopped',''],done:['Done','g'],failed:['Failed','']};
function rsDur(ms){ms=ms||0;const h=Math.floor(ms/3600000),m=Math.floor(ms%3600000/60000);return h?`${h} h ${m} min`:`${m} min`}
function rsRenderJobs(){
  const el=$('rs-jobs');if(!el)return;
  if(!RS.jobs.length){el.innerHTML='';return}
  el.innerHTML=`<div class="sh" style="margin-top:18px"><h2 style="font-size:15px">Your research</h2></div>
  <div class="card" style="padding:0"><table><tbody>${RS.jobs.map(j=>{const s=j.stats||{};const st=RS_ST[j.status]||[j.status,''];
    return `<tr style="cursor:pointer${RS.open===j.id?';background:var(--white)':''}" onclick="rsOpen('${j.id}')">
      <td class="who">${esc(j.title)}<div class="hd">${new Date(j.createdAt).toLocaleString()}</div></td>
      <td><span class="pill ${st[1]}">${st[0]}</span></td>
      <td class="r"><b>${num(s.accepted||0)}</b> <span class="hd">of ${num(j.target||0)} creators</span></td>
      <td class="r hd">${num(s.authorsSeen||0)} seen · ${num(s.vetted||0)} vetted · $${(s.costUsd||0).toFixed(2)}</td></tr>`}).join('')}</tbody></table></div>`}

async function rsOpen(id){
  RS.open=id;RS.shown=150;
  if(RS.poll){clearInterval(RS.poll);RS.poll=null}
  await rsRefresh(true);
  RS.poll=setInterval(()=>{const v=$('rs-detail');if(!v){clearInterval(RS.poll);RS.poll=null;return}
    if(RS.job&&['queued','running','cancel_requested'].includes(RS.job.status))rsRefresh(false)},20000)}

async function rsRefresh(first){
  const id=RS.open;if(!id)return;
  try{const r=await apiFetch('/api/research?op=job&id='+id,{method:'GET'});const j=await r.json();if(j.job)RS.job=j.job}catch(e){}
  await rsLoadResults(id);
  if(first)rsRenderJobs();
  rsRenderDetail()}

async function rsLoadResults(id){
  const cur=RS.results[id]||(RS.results[id]=[]);
  const total=RS.job&&RS.job.resultsCount||0;
  let guard=0;
  while(cur.length<total&&guard++<60){
    const r=await apiFetch(`/api/research?op=results&id=${id}&offset=${cur.length}&limit=400`,{method:'GET'});const j=await r.json();
    if(!j.items||!j.items.length)break;cur.push(...j.items)}}

async function rsCtl(op,extra){
  const id=RS.open;if(!id)return;
  if(op==='cancel'&&typeof confirm==='function'&&!confirm('Stop this research? Everything found so far is kept, and you can resume it later.'))return;
  let addTarget=0;
  if(op==='resume'){const v=typeof prompt==='function'?prompt('Resume and look for how many MORE creators? (0 = keep the same target)','200'):'0';if(v===null)return;addTarget=+String(v).replace(/[^0-9]/g,'')||0}
  await apiFetch('/api/research?op='+op,{method:'POST',body:JSON.stringify({id,addTarget,...(extra||{})})});
  await rsRefresh(true)}

/* ── detail + results ─────────────────────────────────────────────────── */
function rsFiltered(){
  const f=RS.filter,q=f.q.toLowerCase();
  let a=(RS.results[RS.open]||[]).filter(x=>x.score>=f.min&&(!f.email||(x.contacts&&x.contacts.email))&&(!f.clean||x.safety==='clean')
    &&(!q||(x.handle+' '+x.name+' '+x.niche+' '+x.summary+' '+x.bio).toLowerCase().includes(q)));
  const k=f.sort;a=a.slice().sort((x,y)=>k==='followers'?y.followers-x.followers:k==='views'?y.medViews-x.medViews:k==='er'?(y.engagementRate||0)-(x.engagementRate||0):y.score-x.score);
  return a}

function rsRenderDetail(){
  const el=$('rs-detail');if(!el)return;const j=RS.job;
  if(!j||j.id!==RS.open){el.innerHTML='';return}
  const s=j.stats||{},st=RS_ST[j.status]||[j.status,''];const q=s.queue||{};
  const pct=Math.min(100,Math.round((s.accepted||0)/Math.max(1,j.target)*100));
  const strat=j.strategy||{};
  const waiting=j.status==='queued'&&!s.authorsSeen;
  const all=RS.results[j.id]||[],rows=rsFiltered();
  el.innerHTML=`<div class="panel" style="margin-top:14px"><div style="padding:16px 18px">
    <div class="sh"><div><b style="font-weight:500">${esc((j.brief&&(j.brief.title||j.brief.brand))||'Research')}</b> <span class="pill ${st[1]}">${st[0]}</span>
        <span class="hd"> · ${esc(j.phase||'')} · running ${rsDur(s.elapsedMs)} · AI $${(s.costUsd||0).toFixed(2)}</span></div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        ${['queued','running'].includes(j.status)?`<button class="btn sm gh" onclick="rsCtl('cancel')">Stop</button>`:''}
        ${['done','cancelled','failed'].includes(j.status)?`<button class="btn sm" onclick="rsCtl('resume')">Keep searching</button>`:''}
        <button class="btn sm" onclick="rsRefresh(true)">Refresh</button></div></div>
    ${waiting?`<div class="note" style="margin:6px 0 10px">Queued. ${RS.instant?'The worker is starting now.':'The research worker checks for new jobs every 10 minutes — it will start on its own; nothing to keep open.'}</div>`:''}
    <div class="bar"><i style="width:${pct}%"></i></div>
    <div class="pgrid" style="border:1px solid var(--line);border-radius:10px;overflow:hidden">
      <div class="pc"><div class="t">Accepted</div><div class="big">${num(s.accepted||0)}</div><div class="sm2">of ${num(j.target)} wanted · ${num(all.filter(x=>x.contacts&&x.contacts.email).length)} with an email</div></div>
      <div class="pc"><div class="t">Discovered</div><div class="big">${num(s.authorsSeen||0)}</div><div class="sm2">${num(s.postsRead||0)} posts · ${num(s.tagsDone||0)} hashtags explored · ${num(s.tagsQueued||0)} queued</div></div>
      <div class="pc"><div class="t">Triaged · Haiku</div><div class="big">${num(s.triaged||0)}</div><div class="sm2">${num(s.triagePassed||0)} passed · ${num(s.gated||0)} filtered by rules</div></div>
      <div class="pc"><div class="t">Vetted in depth</div><div class="big">${num(s.vetted||0)}</div><div class="sm2">${num(s.dossiers||0)} dossiers · ${num(s.escalated||0)} re-read by Sonnet · ${num(s.rejected||0)} rejected</div></div>
    </div>
    ${q.triage||q.dossier||q.vetting?`<div class="hd" style="margin-top:8px">In the pipeline: ${num(q.triage||0)} awaiting triage · ${num(q.dossier||0)} awaiting dossier · ${num(q.vetting||0)} awaiting vetting</div>`:''}
    ${strat.persona?`<div class="hd" style="margin-top:10px"><b>Target:</b> ${esc(strat.persona)}</div>`:''}
    ${(strat.notes||[]).length?`<div class="note" style="margin-top:10px"><b>Supervisor</b><br>${strat.notes.slice(-4).map(esc).join('<br>')}</div>`:''}
    ${j.report?`<div class="note" style="margin-top:10px"><b>Report</b><br>${rsMd(j.report)}</div>`:''}
    <details style="margin-top:10px"><summary class="hd" style="cursor:pointer">Live log · best hashtags · rejection reasons</summary>
      <div style="display:grid;grid-template-columns:2fr 1fr;gap:14px;margin-top:8px">
        <div class="hd" style="max-height:260px;overflow:auto;line-height:1.6">${(j.log||[]).slice(0,60).map(l=>`${new Date(l.at).toLocaleTimeString()} — ${esc(l.m)}`).join('<br>')}</div>
        <div class="hd">${(strat.bestTags||[]).map(t=>`#${esc(t.t)} · ${t.acc} accepted`).join('<br>')||'—'}<br><br>${(strat.reasons||[]).map(r=>`${esc(r[0])}: ${r[1]}`).join('<br>')}</div></div></details>
  </div></div>
  ${all.length?`<div class="card" style="padding:14px 16px">
    <div class="sh"><b style="font-weight:500">${num(rows.length)} creators${rows.length!==all.length?` <span class="hd">of ${num(all.length)}</span>`:''}</b>
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
        <input placeholder="Search…" style="width:150px" value="${esc(RS.filter.q)}" oninput="RS.filter.q=this.value;RS.shown=150;rsRenderDetail();this.focus()">
        <select onchange="RS.filter.min=+this.value;rsRenderDetail()">${[0,70,80,90].map(v=>`<option value="${v}" ${RS.filter.min===v?'selected':''}>${v?'score ≥ '+v:'any score'}</option>`).join('')}</select>
        <select onchange="RS.filter.sort=this.value;rsRenderDetail()">${[['score','best fit'],['followers','followers'],['views','median views'],['er','engagement']].map(([v,n])=>`<option value="${v}" ${RS.filter.sort===v?'selected':''}>${n}</option>`).join('')}</select>
        <label class="hd"><input type="checkbox" ${RS.filter.email?'checked':''} onchange="RS.filter.email=this.checked;rsRenderDetail()"> email</label>
        <label class="hd"><input type="checkbox" ${RS.filter.clean?'checked':''} onchange="RS.filter.clean=this.checked;rsRenderDetail()"> brand-safe only</label>
        <button class="btn sm" onclick="rsExportCsv()">Export CSV</button>
        <button class="btn sm p" onclick="rsSaveLists()">Save to Lists</button></div></div>
    <table><thead><tr><th>Creator</th><th class="r">Followers</th><th class="r">Median views</th><th class="r">Eng.</th><th>Fit</th><th>Contact</th></tr></thead><tbody>
    ${rows.slice(0,RS.shown).map(rsRow).join('')}</tbody></table>
    ${rows.length>RS.shown?`<div style="text-align:center;margin-top:10px"><button class="btn sm" onclick="RS.shown+=200;rsRenderDetail()">Show more (${num(rows.length-RS.shown)})</button></div>`:''}
  </div>`:''}`}

function rsRow(x){
  const c=x.contacts||{};const sc=x.score>=85?'var(--sage)':x.score>=75?'var(--ink)':'var(--ink3)';
  const safe=x.safety==='clean'?'':`<span style="color:var(--rust-d)"> · ⚑ ${esc(x.safety)}${x.safetyNotes?': '+esc(x.safetyNotes):''}</span>`;
  return `<tr style="vertical-align:top">
    <td style="min-width:280px"><div style="display:flex;gap:10px">
      ${x.avatar?`<img src="${esc(x.avatar)}" loading="lazy" referrerpolicy="no-referrer" style="width:38px;height:38px;border-radius:50%;object-fit:cover;flex:none" onerror="this.style.display='none'">`:''}
      <div><a class="who" href="${esc(x.url)}" target="_blank" rel="noopener">@${esc(x.handle)}</a>${x.verified?' ✓':''} <span class="hd">${esc(x.name||'')}</span>
      <div class="hd" style="margin-top:3px;max-width:520px">${esc(x.summary||x.fit||'')}</div>
      <details><summary class="hd" style="cursor:pointer">details</summary><div class="hd" style="line-height:1.6;max-width:560px">
        <b>Why:</b> ${esc(x.fit)}<br><b>Audience:</b> ${esc(x.audience)} · <b>Style:</b> ${esc(x.style)}<br>
        <b>Collab idea:</b> ${esc(x.collab)}<br><b>Bio:</b> ${esc(x.bio)}<br>
        <b>Activity:</b> ${x.postsPerWeek||0} posts/week · last post ${x.lastPostDays==null?'?':x.lastPostDays+' d ago'} · ${num(x.hearts||0)} total likes · views/followers ${x.viewsToFollowers??'—'}${x.sponsoredShare?` · ${Math.round(x.sponsoredShare*100)}% sponsored`:''}<br>
        ${(x.topVideos||[]).map(v=>`<a href="${esc(v.url)}" target="_blank" rel="noopener">▶ ${num(v.views)} views</a> ${esc(v.desc)}`).join('<br>')}<br>
        <span>Found via ${esc((x.foundVia||[]).map(t=>t.startsWith('@')?t:'#'+t).join(', '))} · reviewed by ${esc(x.reviewedBy)}${(x.flags||[]).length?' · flags: '+esc(x.flags.join(', ')):''}</span></div></details></div></div></td>
    <td class="r">${num(x.followers||0)}</td><td class="r">${num(x.medViews||0)}</td><td class="r">${x.engagementRate!=null?x.engagementRate+'%':'—'}</td>
    <td><b style="color:${sc}">${x.score}</b> <span class="hd">${esc(x.niche)}</span>${safe}</td>
    <td class="hd" style="white-space:nowrap">${c.email?`<a href="mailto:${esc(c.email)}">${esc(c.email)}</a><br>`:''}${c.instagram?`IG ${esc(c.instagram)}<br>`:''}${c.youtube?`<a href="${esc(c.youtube)}" target="_blank" rel="noopener">YouTube</a><br>`:''}${c.link?`<a href="${esc(c.link)}" target="_blank" rel="noopener">link in bio</a>`:''}${!c.email&&!c.instagram&&!c.link?'DM on TikTok':''}</td></tr>`}

function rsExportCsv(){
  const rows=rsFiltered();if(!rows.length)return;
  const cols=['handle','name','url','followers','medViews','engagementRate','postsPerWeek','lastPostDays','score','niche','safety','email','otherEmails','instagram','youtube','link','summary','fit','collab','audience','style','bio','foundVia'];
  const val=(x,k)=>{const c=x.contacts||{};const v=k==='email'?c.email:k==='otherEmails'?(c.otherEmails||[]).join(' '):k==='instagram'?c.instagram:k==='youtube'?c.youtube:k==='link'?c.link:k==='foundVia'?(x.foundVia||[]).join(' '):x[k];
    return '"'+String(v??'').replace(/"/g,'""').replace(/\n/g,' ')+'"'};
  const csv=[cols.join(','),...rows.map(x=>cols.map(k=>val(x,k)).join(','))].join('\n');
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['﻿'+csv],{type:'text/csv'}));
  a.download=`cadence-research-${RS.open}.csv`;a.click()}

async function rsSaveLists(){
  const rows=rsFiltered();if(!rows.length)return;
  const base=(RS.job&&RS.job.brief&&(RS.job.brief.title||RS.job.brief.brand))||'Research';
  const name=typeof prompt==='function'?prompt('List name',base):base;if(!name)return;
  const recs=rows.map(x=>({id:'tt:'+x.handle,name:x.name||x.handle,handle:'@'+x.handle,platform:'tiktok',email:(x.contacts&&x.contacts.email)||'',url:x.url,
    subs:x.followers,medViews:x.medViews,kw:(x.foundVia||[])[0]||'',country:'',ai:{fit:x.score,niche:x.niche,why:x.fit,flags:x.flags||[]}}));
  const parts=Math.ceil(recs.length/500);
  for(let i=0;i<parts;i++)await saveList(parts>1?`${name} (${i+1}/${parts})`:name,recs.slice(i*500,i*500+500),
    {source:'research',jobId:RS.open,platform:'tiktok',summary:RS.job&&RS.job.strategy&&RS.job.strategy.persona||''});
  alert(`Saved ${num(recs.length)} creators to Lists${parts>1?` (${parts} lists)`:''}.`)}

/* ── panel ────────────────────────────────────────────────────────────── */
function rsPanel(){
  setTimeout(rsMount,0);
  return `<div class="card">
    <div class="sh" style="margin-bottom:10px"><h2 style="font-size:19px">Deep creator research</h2>
      <span class="pill g">AI-supervised · no paid scraper</span></div>
    <div class="hd" style="font-size:13.5px;line-height:1.6;margin-bottom:12px">Explain what you need to the strategist. It asks the right questions, writes the brief, then an autonomous search explores TikTok hashtag by hashtag, follows the trails the best creators leave (the hashtags they use, the creators they tag), and vets every candidate on their real latest videos — niche, values, brand safety, audience, engagement — before anyone reaches your list. It runs in the cloud for as long as it takes.</div>
    <div id="rs-chat" style="max-height:420px;overflow:auto;padding:4px 2px;background:transparent"></div>
    <div style="display:flex;gap:8px;margin-top:8px">
      <textarea id="rs-in" style="min-height:52px;flex:1" placeholder="e.g. We're Teveo, a gym apparel brand. We want thousands of gym creators — bodybuilding, strength — with a clean, positive image…" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();rsSend()}"></textarea>
      <div style="display:flex;flex-direction:column;gap:6px"><button class="btn p" onclick="rsSend()">Send</button><button class="btn sm gh" onclick="rsResetChat()">New brief</button></div></div>
    <div id="rs-brief"></div>
    <div id="rs-jobs"></div>
    <div id="rs-detail"></div>
  </div>`}

function rsMount(){
  if(!$('rs-chat'))return;
  rsRenderChat();rsRenderBrief();rsRenderJobs();rsRenderDetail();
  rsLoadJobs().then(()=>{if(!RS.open&&RS.jobs[0])rsOpen(RS.jobs[0].id);else if(RS.open)rsOpen(RS.open)})}
