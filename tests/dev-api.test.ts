import assert from 'node:assert/strict';
import { createServer as http } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { createServer } from 'vite';
import { devApi } from '../scripts/dev-api.ts';

test('frontend responds while API waits for backend; POST is forwarded exactly once',async()=>{
  const backend=http(async(request,response)=>{
    requests++;
    let body='';for await(const chunk of request)body+=chunk;
    response.setHeader('Content-Type','application/json');response.end(JSON.stringify({body}));
  });
  let requests=0;
  backend.listen(0,'127.0.0.1');await once(backend,'listening');
  const port=(backend.address() as {port:number}).port;
  await new Promise<void>(resolve=>backend.close(()=>resolve()));
  const target=new URL(`http://127.0.0.1:${port}`);
  const vite=await createServer({configFile:false,plugins:[devApi(target),{name:'probe',configureServer(server){server.middlewares.use('/probe',(_req,res)=>res.end('frontend ready'));}}],server:{port:0,host:'127.0.0.1',proxy:{'/api':target.href}}});
  await vite.listen();const base=`http://127.0.0.1:${(vite.httpServer!.address() as {port:number}).port}`;
  try {
    const pending=fetch(base+'/api/characters',{method:'POST',body:'character'});
    assert.equal(await(await fetch(base+'/probe')).text(),'frontend ready');assert.equal(requests,0);
    backend.listen(port,'127.0.0.1');await once(backend,'listening');
    const response=await pending;assert.equal(response.status,200);assert.deepEqual(await response.json(),{body:'character'});assert.equal(requests,1);
  } finally {await vite.close();backend.closeAllConnections();if(backend.listening)await new Promise<void>(resolve=>backend.close(()=>resolve()));}
});

test('unavailable backend returns JSON 503 instead of a proxy connection error',async()=>{
  const target=new URL('http://127.0.0.1:1');
  const vite=await createServer({configFile:false,plugins:[devApi(target,0)],server:{port:0,host:'127.0.0.1',proxy:{'/api':target.href}}});
  await vite.listen();
  try {
    const response=await fetch(`http://127.0.0.1:${(vite.httpServer!.address() as {port:number}).port}/api/characters`);
    assert.equal(response.status,503);assert.match((await response.json() as {error:string}).error,/Сервер комнаты/);
  } finally {await vite.close();}
});
