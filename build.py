"""Builds cadence-deploy/index.html from the last deployed app (base.html) + brain.js
+ event hooks in every feature. Run: python3 build.py"""
import os, hashlib
H=os.path.dirname(os.path.abspath(__file__))
s=open(os.path.join(H,'src','base.html'),encoding='utf-8').read()
brain=open(os.path.join(H,'src','brain.js'),encoding='utf-8').read()
state=open(os.path.join(H,'src','state.js'),encoding='utf-8').read()
analytics=open(os.path.join(H,'api','_analytics.js'),encoding='utf-8').read()
discovery=open(os.path.join(H,'src','discovery.js'),encoding='utf-8').read()
research=open(os.path.join(H,'src','research.js'),encoding='utf-8').read()

def rep(old,new,count=1):
    global s
    n=s.count(old)
    assert n==count,('pattern count',n,old[:90])
    s=s.replace(old,new)

# ── old in-page key + transport removed (brain.js replaces it) ──
a=s.index("function aiCfg(){if(!db.ai)db.ai={key:'',model:'claude-sonnet-4-5'};return db.ai}")
b=s.index("/* Everything the agent is allowed to know")
s=s[:a]+"/* aiCfg, aiReady and runAgent live in the BRAIN block at the end. The model key is held by the backend. */\n\n"+s[b:]
rep("if(!db.ai)db.ai={key:'',model:'claude-sonnet-4-5'};","if(!db.ai)db.ai={};")
rep("""    ${ready?'':`<div class="fg"><label>Anthropic API key</label>
      <input type="password" placeholder="sk-ant-..." onchange="db.ai={key:this.value,model:'claude-sonnet-4-5'};save();renderOut()"></div>
      <div class="quota" style="text-align:left">Stored in this browser only. Without it the editor
        still works — you just write the email yourself.</div>`}""",
"""    ${ready?'':`<div class="note">The AI backend is not connected yet — open <b>Copilot</b> to see why.
      The editor still works meanwhile; you just write the email yourself.</div>`}""")
rep("""      <button class="btn sm gh" onclick="db.ai.key='';save();renderOut()">Disconnect</button>\n""","")
rep("${ready?'connected':'no model key'}","${ready?'connected':'AI offline'}")
rep("No model key connected — nothing here runs by itself yet. Go to Outreach → Message and add an Anthropic API key to turn on automatic triage, address capture and link checks.",
    "The AI backend is not connected — nothing here runs by itself yet. Open Copilot to see what is missing.")
rep("No model key connected — replies can still be fetched, but nothing gets triaged or drafted until you add an Anthropic API key in step 2 (Message).",
    "The AI backend is not connected — replies can still be fetched, but nothing gets triaged or drafted. Open Copilot to see what is missing.")
rep("disabled title=\"Add an API key in step 2 first\"","disabled title=\"AI backend not connected\"")
assert 'claude-sonnet-4-5' not in s and 'sk-ant' not in s

# ── inbox: triage with the real creator record, then report ──
rep("const creator={name:rep.name,email:rep.email,handle:'',platform:'youtube',views:0};",
 "const pp=rep.creatorId&&db.pipe&&db.pipe[rep.creatorId],ss=(db.out.sent||[]).find(x=>x.id===rep.creatorId)||{};\n    const creator={name:rep.name,email:rep.email,handle:pp&&pp.handle||'',platform:pp&&pp.platform||'youtube',views:ss.views||0};")
rep("""      await tryExtractAddress(rep);
    }
  }catch(e){rep.status='error';rep.err=e.message}
  save();renderOut()}""","""      await tryExtractAddress(rep);
    }
    aiEmit('reply_triaged',{rep});
  }catch(e){rep.status='error';rep.err=e.message}
  save();renderOut()}""")
rep("known.add(last.id);found++;","known.add(last.id);found++;\n    emit('reply_received',{gmId:last.id,creatorId:sent&&sent.id||'',name:sent&&sent.name||''});")
rep("""      setStage(p,'address_ready','Address captured automatically from their reply');""",
    """      setStage(p,'address_ready','Address captured automatically from their reply');
      emit('address_captured',{id:p.id,name:p.name,by:'triage'});""")

# ── pipeline: every stage move is an event ──
rep("function setStage(p,stage,msg){if(p.stage!==stage){p.stage=stage;pipeLog(p,msg||STAGE_LABEL(stage))}save()}",
    "function setStage(p,stage,msg){if(p.stage!==stage){const from=p.stage;p.stage=stage;pipeLog(p,msg||STAGE_LABEL(stage));\n  emit('stage_changed',{id:p.id,name:p.name,from,stage,why:String(msg||'').slice(0,120)})}save()}")
rep("""    if(hasLink){setStage(p,'live_ok','Video confirmed — the link is in the description')}""",
    """    if(hasLink){const was=p.stage;setStage(p,'live_ok','Video confirmed — the link is in the description');if(was!=='live_ok')emit('video_ok',{id:p.id,name:p.name})}""")
rep("""      if(!already)await nudgeMissingLink(p);""",
    """      if(!already){const nd=await nudgeMissingLink(p);emit('video_missing_link',{id:p.id,name:p.name,nudged:!!nd})}""")
rep("opsLog(`Nudged ${p.name||p.email} — their video is live but missing the link.`);",
    "opsLog(`Nudged ${p.name||p.email} — their video is live but missing the link.`);return true;")
rep("p.shippedAt=new Date().toISOString();setStage(p,'shipped','Marked as shipped');",
    "p.shippedAt=new Date().toISOString();setStage(p,'shipped','Marked as shipped');emit('shipped',{id:p.id,name:p.name});")
rep("p.videoUrl=val.trim();if(p.videoUrl&&p.stage==='shipped')",
    "p.videoUrl=val.trim();if(p.videoUrl)emit('video_added',{id:p.id,name:p.name,url:p.videoUrl.slice(0,120)});if(p.videoUrl&&p.stage==='shipped')")

# ── outreach ──
rep("""    if(res.ok){await idbSetStatus([rec.id],'contacted');setStage(pipeRec(rec),'contacted','First email sent')}""",
    """    emit(res.ok?'email_sent':'email_failed',{id:rec.id,name:rec.name,count:1,err:res.err||''});
    if(res.ok){await idbSetStatus([rec.id],'contacted');setStage(pipeRec(rec),'contacted','First email sent')}""")
rep("  c.running=true;c.nextAt=0;save();\n","  c.running=true;c.nextAt=0;save();\n  emit('sending_started',{queue:c.queue.length});\n")
rep("function stopOut(){db.out.running=false;save();",
    "function stopOut(){if(db.out.running)emit('sending_stopped',{queue:(db.out.queue||[]).length,sent:(db.out.sent||[]).length});db.out.running=false;save();")
rep("  save();renderOutQueueBadge();\n  alert(`${added} added to Outreach.",
    "  save();renderOutQueueBadge();\n  emit('queued',{count:added,no_email:t.length-withMail.length});\n  alert(`${added} added to Outreach.")

# ── discovery & match ──
rep("t.oncomplete=()=>res({added,seen});t.onerror=()=>rej(t.error)})}",
    "t.oncomplete=()=>{res({added,seen});if(recs.length)emit('leads_saved',{added,seen,platform:(recs[0]&&recs[0].platform)||'youtube',keyword:String(recs[0]&&recs[0].kw||'').slice(0,80)})};t.onerror=()=>rej(t.error)})}")
rep("  running=false;b.innerHTML='Find creators';b.disabled=false;\n  const total=",
    "  running=false;b.innerHTML='Find creators';b.disabled=false;\n  if(fail)emit('discovery_failed',{platform:'youtube',err:String(fail).slice(0,200)});\n  const total=")
rep("  running=false;b.innerHTML='Find creators';b.disabled=false;\n  $('dProg').innerHTML=",
    "  running=false;b.innerHTML='Find creators';b.disabled=false;\n  if(fail)emit('discovery_failed',{platform:PLAT,err:String(fail).slice(0,200)});\n  $('dProg').innerHTML=")
rep("    cpm:reach?+(spend/reach*1000).toFixed(2):0};\n  renderRoster();",
    "    cpm:reach?+(spend/reach*1000).toFixed(2):0};\n  emit('roster_built',{count:roster.length,pool:all.length,eligible:scored.length,spend:Math.round(spend),reach:Math.round(reach)});\n  renderRoster();")
rep("  await idbSetStatus(ids,st);sel.clear();selAll=false;loadPage()}",
    "  await idbSetStatus(ids,st);emit('leads_status',{count:ids.length,status:st});sel.clear();selAll=false;loadPage()}")

# ── campaigns, money, settings ──
rep("  db.campaigns.unshift(draft);save();renderList();openCamp(draft.id)}",
    "  db.campaigns.unshift(draft);save();\n  emit('campaign_launched',{id:draft.id,name:draft.product,budget:draft.budget,creators:(draft.creators||[]).length});\n  renderList();openCamp(draft.id)}")
rep("  cur.videos.push(v);save();renderCamp();",
    "  cur.videos.push(v);save();renderCamp();emit('video_added',{camp:cur.id,cr,url:u.slice(0,120)});")
rep("  if(v){v.views=Math.max(0,parseInt(String(val).replace(/[^0-9]/g,''))||0);save();renderCamp()}}",
    "  if(v){v.views=Math.max(0,parseInt(String(val).replace(/[^0-9]/g,''))||0);save();renderCamp();emit('views_updated',{camp:cur.id,video:id,views:campViews(cur),manual:true})}}")
rep("  for(const v of cur.videos){const e=await fetchOne(v);if(e){err=e}else{ok++}}\n  save();renderCamp();",
    "  for(const v of cur.videos){const e=await fetchOne(v);if(e){err=e}else{ok++}}\n  save();renderCamp();\n  emit('views_updated',{camp:cur.id,videos:ok,views:campViews(cur),err:err||''});")
rep("cur.history.unshift({date:new Date().toISOString().slice(0,10),total:t,lines});\n  save();renderCamp();}",
    "cur.history.unshift({date:new Date().toISOString().slice(0,10),total:t,lines});\n  save();aiEmit('payout',{camp:cur.id,total:t,lines:lines.length,date:new Date().toISOString().slice(0,10)});renderCamp();}")
rep("  db.brief.market=db.brand.market;\n",
    "  db.brief.market=db.brand.market;\n  emit('brand_updated',{product:db.brand.product,market:db.brand.market,url:db.brand.url});\n")

# ── storage built for thousands: settings in localStorage, collections in IndexedDB ──
a=s.index("function save(){try{localStorage.setItem('cadence',JSON.stringify(db))}catch(e){}}")
b=s.index("function show(v){")
s=s[:a]+state+"\n"+s[b:]
rep("""load();renderList();renderOutQueueBadge();renderPipeBadge();landInit();
if(db.out&&db.out.running){outTimer=setInterval(outTick,5000)}
if(db.out&&db.out.inbox&&db.out.inbox.mode!=='off')inboxAutoLoop();""",
"""load();renderList();renderOutQueueBadge();renderPipeBadge();landInit();
/* Timers that write to the collections start only once they are loaded. */
const stateReadyP=stateHydrate().then(()=>{renderList();renderOutQueueBadge();renderPipeBadge();
  const on=document.querySelector('nav button.on');if(on&&on.dataset.v)show(on.dataset.v);
  if(db.out&&db.out.running){outTimer=setInterval(outTick,5000)}
  if(db.out&&db.out.inbox&&db.out.inbox.mode!=='off')inboxAutoLoop()});""")

# ── one creator record, enriched once, linked everywhere ──
rep("""function pipeRec(rec){
  if(!db.pipe)db.pipe={};
  if(!db.pipe[rec.id])db.pipe[rec.id]={id:rec.id,name:rec.name||'',email:rec.email||'',
    handle:rec.handle||'',platform:rec.platform||'youtube',stage:'shortlisted',
    addr:null,videoUrl:'',shippedAt:'',log:[]};
  return db.pipe[rec.id]}""","""function pipeRec(rec){
  if(!db.pipe)db.pipe={};
  let p=db.pipe[rec.id];
  if(!p)p=db.pipe[rec.id]={id:rec.id,name:rec.name||'',email:rec.email||'',
    handle:rec.handle||'',platform:rec.platform||'youtube',stage:'shortlisted',
    addr:null,videoUrl:'',shippedAt:'',log:[],addedAt:new Date().toISOString()};
  /* segment attributes the agent compares on — filled once, never overwritten */
  const attrs={views:rec.medViews||rec.lifetimeAvg||rec.views||0,subs:rec.subs,kw:rec.kw,country:rec.country};
  for(const [k,v] of Object.entries(attrs))if(v&&!p[k])p[k]=v;
  if(rec.email&&!p.email)p.email=rec.email;
  return p}""")
rep("""  matchRows.forEach(r=>c.creators.push({id:uid(),name:r.name,handle:r.email||r.url,rate:c.rate,
    code:(r.name||'').replace(/[^A-Za-z]/g,'').toUpperCase().slice(0,8)}));""",
"""  matchRows.forEach(r=>{c.creators.push({id:uid(),pid:r.id,name:r.name,handle:r.email||r.url,rate:c.rate,
    code:(r.name||'').replace(/[^A-Za-z]/g,'').toUpperCase().slice(0,8)});pipeRec(r).campaignId=c.id});""")
rep("""  t.forEach(l=>c.creators.push({id:uid(),name:l.name,handle:l.email||l.url,rate:c.rate,
    code:(l.name||'').replace(/[^A-Za-z]/g,'').toUpperCase().slice(0,8)}));""",
"""  t.forEach(l=>{c.creators.push({id:uid(),pid:l.id,name:l.name,handle:l.email||l.url,rate:c.rate,
    code:(l.name||'').replace(/[^A-Za-z]/g,'').toUpperCase().slice(0,8)});pipeRec(l).campaignId=c.id});""")

# ── discovery engine: AI-ranked creators blend into the fit score ──
rep("""    if(m.cadence&&/consistent/.test(m.cadence.label))n+=4;
  }
  return Math.max(0,Math.min(100,Math.round(n)))}""","""    if(m.cadence&&/consistent/.test(m.cadence.label))n+=4;
  }
  /* The AI read their bio and captions against the brief: that outweighs the heuristics. */
  if(r.ai&&r.ai.fit!=null){n=n*0.35+r.ai.fit*0.65;
    if((r.ai.flags||[]).some(f=>/brand|kids|adult|repost/.test(f)))n-=30;
    else if((r.ai.flags||[]).length)n-=10}
  return Math.max(0,Math.min(100,Math.round(n)))}""")
rep("${PLAT==='youtube'?ytPanel(left):provPanel()}",
 "${PLAT==='youtube'?ytPanel(left):PLAT==='tiktok'?rsPanel()+`<details class=\"card\" style=\"padding:14px 18px\"><summary class=\"hd\" style=\"cursor:pointer\">Legacy paid engine (Apify) and manual keyword search</summary>${dxPanel()}${provPanel()}</details>`:provPanel()}")

rep("${l.created?` · since ${l.created.slice(0,4)}`:''}${linkBits(l)}</span>",
 "${l.created?` · since ${l.created.slice(0,4)}`:''}${linkBits(l)}</span>${l.ai?`<br><span class=\"hd\" style=\"color:var(--sage)\">AI ${l.ai.fit} · ${esc(l.ai.niche)}${l.ai.why?' — '+esc(l.ai.why):''}${(l.ai.flags||[]).length?` <span style=\"color:var(--rust-d)\">⚑ ${esc(l.ai.flags.join(', '))}</span>`:''}</span>`:''}")

# ── Copilot view ──
rep("""    <button data-v="payouts" onclick="show('payouts')">Dashboard</button></nav>""",
 """    <button data-v="payouts" onclick="show('payouts')">Dashboard</button>
    <button data-v="ai" onclick="show('ai')">Copilot<span id="aiBadge"></span></button></nav>""")
rep("""<div class="view" id="v-payouts">""","""<div class="view" id="v-ai">
  <div class="head"><div><h1>Copilot</h1>
    <div class="sub">One Sonnet agent that every feature reports to — discovery, outreach, inbox, pipeline,
      campaigns and payouts. It sorts the stream, reacts as things happen, keeps working on the server
      while this tab is closed, and hands you only what needs a decision.</div></div></div>
  <div id="aiBody"></div>
</div>

<div class="view" id="v-payouts">""")
rep("  if(v==='pipeline')renderPipe();\n","  if(v==='pipeline')renderPipe();\n  if(v==='ai')renderAi();\n")

# ── triage lives in brain.js now (structured, batched, checked) ──
a=s.index("async function triageReply(rep){")
b=s.index("async function sendReply(rep,silent){")
s=s[:a]+"/* triageReply / triageAllNew: see TRIAGE in the BRAIN block. */\n\n"+s[b:]

# ── deliveries in the pipeline ──
rep("""function markShipped(id){const p=db.pipe&&db.pipe[id];if(!p)return;
  p.shippedAt=new Date().toISOString();setStage(p,'shipped','Marked as shipped');emit('shipped',{id:p.id,name:p.name});renderPipe()}""",
"""function markShipped(id){const p=db.pipe&&db.pipe[id];if(!p)return;
  const tr=typeof prompt==='function'?(prompt('Tracking number (optional — leave empty if none):')||'').trim():'';
  const ca=tr&&typeof prompt==='function'?(prompt('Carrier (UPS, USPS, DHL, Colissimo…):')||'').trim():'';
  p.shippedAt=new Date().toISOString();setStage(p,'shipped','Marked as shipped');emit('shipped',{id:p.id,name:p.name,tracking:!!tr});
  updateShipment(p,{status:'shipped',tracking:tr,carrier:ca,note:tr?'tracking '+tr:'marked shipped',source:'you'});renderPipe()}
function shipCell(p){const sh=p.ship||{};if(!p.shippedAt)return '';
  const d=Math.floor((Date.now()-new Date(sh.deliveredAt||p.shippedAt).getTime())/86400000);
  const lab={shipped:'In transit',in_transit:'In transit',delivered:'Delivered',issue:'Delivery problem',returned:'Returned'}[sh.status||'shipped']||'Shipped';
  const u=trackingUrl(sh);
  return `<div class="hd">${esc(lab)} · ${d} d${u?` · <a href="${esc(u)}" target="_blank" rel="noopener">${esc(sh.carrier||'track')}</a>`:''}
    ${sh.status!=='delivered'?` · <a href="#" onclick="updateShipment(db.pipe['${p.id}'],{status:'delivered',note:'confirmed by you',source:'you'});renderPipe();return false">mark delivered</a>`:''}</div>`}""")
rep("""        <td class="who">${esc(p.name||p.email)}${p.stage==='live_missing_link'?""","""        <td class="who">${esc(p.name||p.email)}${shipCell(p)}${p.stage==='live_missing_link'?""")

i=s.rindex('</script>')
s=s[:i]+analytics+'\n'+brain+'\n'+discovery+'\n'+research+s[i:]
open(os.path.join(H,'index.html'),'w',encoding='utf-8').write(s)
print('index.html',len(s.encode()),hashlib.sha1(s.encode()).hexdigest())
