import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {WebSocketServer} from 'ws';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {Codex} from '../server/codex.js';
test('bridge and deployment verifier perform WebSocket handshake over Unix socket',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'cm-uds-')), socket=path.join(dir,'control.sock');
 const server=createServer();const wss=new WebSocketServer({server});let connections=0;
 wss.on('connection',ws=>{connections++;ws.on('message',raw=>{const m=JSON.parse(raw.toString());if(m.id!==undefined)ws.send(JSON.stringify({id:m.id,result:m.method==='model/list'?{data:[{id:'uds-test'}]}:{}}));});});
 await new Promise<void>(resolve=>server.listen(socket,resolve));
 const keys=['CODEX_SOCKET','CODEX_CONNECTION','CODEX_REMOTE_URL','CODEX_ARGS_JSON'];const saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 let codex:Codex|undefined;
 try{
  process.env.CODEX_SOCKET=socket;process.env.CODEX_CONNECTION='shared';delete process.env.CODEX_REMOTE_URL;delete process.env.CODEX_ARGS_JSON;
  codex=new Codex();await codex.start();assert(codex.ready);assert.equal((await codex.call('model/list')).data[0].id,'uds-test');codex.close();
  const result=await new Promise<{code:number|null;output:string}>((resolve,reject)=>{
   const p=spawn(process.execPath,['deploy/verify-shared.mjs',dir],{env:{...process.env,CODEX_SOCKET:socket}});let output='';p.stdout.on('data',b=>output+=b);p.stderr.on('data',b=>output+=b);p.on('error',reject);p.on('exit',code=>resolve({code,output}));
  });
  assert.equal(result.code,0,result.output);assert.match(result.output,/initialize 成功/);assert.equal(connections,2);
 }finally{codex?.close();for(const k of keys){if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];}for(const c of wss.clients)c.terminate();wss.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}
});
