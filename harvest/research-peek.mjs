// Cheap pre-check so scheduled runs with nothing to do exit in seconds,
// before installing a browser. Writes work=true|false to $GITHUB_OUTPUT.
import {appendFileSync} from 'fs';
const BASE=(process.env.CADENCE_URL||'').replace(/\/$/,'');
let work=false;
try{const r=await fetch(`${BASE}/api/research?op=peek`,{method:'POST',headers:{'content-type':'application/json','x-worker-secret':process.env.FREE_HARVEST_SECRET||''},body:'{}'});
  const j=await r.json();work=!!j.work;console.log('peek',r.status,JSON.stringify(j))}
catch(e){console.log('peek failed',e.message)}
if(process.env.GITHUB_OUTPUT)appendFileSync(process.env.GITHUB_OUTPUT,`work=${work}\n`);
