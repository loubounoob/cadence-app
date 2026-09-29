const fs=require('fs');const {JSDOM,VirtualConsole}=require('jsdom');const FIDB=require('fake-indexeddb');
const html=fs.readFileSync(__dirname+'/../index.html','utf8');const errs=[];
const vc=new VirtualConsole();vc.on('jsdomError',e=>errs.push(e.message));vc.on('error',e=>errs.push(String(e)));
const dom=new JSDOM(html,{runScripts:'dangerously',url:'https://cadence-app-amber.vercel.app/',virtualConsole:vc,beforeParse(w){w.__noTimers=true;w.indexedDB=FIDB.indexedDB;w.IDBKeyRange=FIDB.IDBKeyRange;w.IntersectionObserver=class{observe(){}unobserve(){}};w.scrollTo=()=>{};
 w.fetch=async u=>({status:200,headers:{get:()=>null},json:async()=>(String(u).includes('health')?{ok:true,key:true,storage:false}:{})})}});
const w=dom.window;
setTimeout(()=>{for(const v of ['ai','discover','match','outreach','pipeline','payouts','link','land']){try{w.eval(`show('${v}')`)}catch(e){errs.push(v+': '+e.message)}}
 setTimeout(()=>{console.log('errors:',errs.length?errs:'none');process.exit(0)},400)},100);
