// Run an isolated real Codex app-server on 4508 and bridge on 3053 first.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {WebSocket} from 'ws';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function client(url, headers={}) {
 const ws=new WebSocket(url,{headers});await new Promise((ok,no)=>{ws.once('open',ok);ws.once('error',no)});
 let seq=0;const pending=new Map();const events=[];
 ws.on('message',raw=>{const m=JSON.parse(raw);if(m.id!==undefined&&pending.has(m.id)){const r=pending.get(m.id);pending.delete(m.id);clearTimeout(r.timer);m.error?r.no(new Error(typeof m.error==='string'?m.error:m.error.message)):r.ok(m.result);}else events.push(m);});
 return {ws,events,call:(field,name,params={})=>new Promise((ok,no)=>{const id=String(++seq);const timer=setTimeout(()=>{pending.delete(id);no(new Error('timeout '+name));},60000);pending.set(id,{ok,no,timer});ws.send(JSON.stringify({id,[field]:name,params}));})};
}
const origin='http://127.0.0.1:3053';
const response=await fetch(origin+'/api/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({token:fs.readFileSync('.runtime/shared-bridge/access-token','utf8').trim()})});
const mobile=await client('ws://127.0.0.1:3053/ws',{Origin:origin,Cookie:response.headers.get('set-cookie').split(';')[0]});
const desktop=await client('ws://127.0.0.1:4508');
try {
 await desktop.call('method','initialize',{clientInfo:{name:'shared_desktop_test',version:'0.2.0'},capabilities:{experimentalApi:false}});desktop.ws.send(JSON.stringify({method:'initialized'}));
 const cwd=fs.realpathSync('.runtime/shared-project');
 const state=await mobile.call('action','create',{cwd});
 console.log('MOBILE_CREATED',state.id,state.model,state.effort);
 await mobile.call('action','send',{threadId:state.id,text:'只回复 MOBILE_314159，不要调用任何工具。'});
 const wait=async(id)=>{for(let i=0;i<90;i++){let r;try{r=await desktop.call('method','thread/read',{threadId:id,includeTurns:true});}catch(e){if(/no rollout found|is empty/.test(e.message)){await sleep(500);continue;}throw e;}if(r.thread.turns.length&&r.thread.turns.at(-1).status!=='inProgress')return r.thread;await sleep(1000);}throw new Error('inference timeout');};
 let t=await wait(state.id);assert(JSON.stringify(t).includes('MOBILE_314159'));
 const resumed=await desktop.call('method','thread/resume',{threadId:state.id});assert.equal(resumed.thread.id,state.id);

 await desktop.call('method','turn/start',{threadId:state.id,input:[{type:'text',text:'只回复 DESKTOP_271828，不要调用任何工具。'}]});
 await wait(state.id);
 let refreshed=await mobile.call('action','open',{threadId:state.id});assert(JSON.stringify(refreshed.items).includes('DESKTOP_271828'));
 const other=await desktop.call('method','thread/start',{cwd});
 await desktop.call('method','turn/start',{threadId:other.thread.id,input:[{type:'text',text:'只回复 CREATED_ON_DESKTOP，不要调用工具。'}]});
 await wait(other.thread.id);
 const listing=await mobile.call('action','list',{cwd});assert(listing.data.some(t=>t.id===other.thread.id));
 const imported=await mobile.call('action','open',{threadId:other.thread.id});assert.equal(imported.id,other.thread.id);
 const report={result:'PASS',mobileThread:state.id,desktopThread:other.thread.id,checks:['mobile-created thread resumed by desktop','desktop turn streamed to mobile','same ID and native history','desktop-created thread listed and resumed by mobile'],model:state.model};
 fs.writeFileSync('artifacts/shared-live.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{mobile.ws.close();desktop.ws.close();}
