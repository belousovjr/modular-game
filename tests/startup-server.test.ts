import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { request } from 'node:http';
import { openStartupServer } from '../server/startup.ts';
import { startRoom } from '../server/room.ts';
import { createNpcNavigation, createNpcNavigationAsync, createNpcAuthority } from '../src/modules/npcs/headless.ts';

test('HTTP and API stay live during initialization; the ready room reuses the listening port',async()=>{
  const origin='http://localhost:5175';
  const api=new Map([['/api/characters',async(_req:import('node:http').IncomingMessage,res:import('node:http').ServerResponse)=>{res.writeHead(200).end('characters');}]]);
  const startup=await openStartupServer(0,'127.0.0.1',[origin],api);
  const port=(startup.server.address() as {port:number}).port,base=`http://127.0.0.1:${port}`;
  let room:ReturnType<typeof startRoom>|undefined;
  try {
    assert.equal(await(await fetch(base+'/healthz')).text(),'starting');
    assert.equal((await fetch(base+'/readyz')).status,503);
    const apiResponse=await fetch(base+'/api/characters',{headers:{origin}});
    assert.equal(await apiResponse.text(),'characters');assert.equal(apiResponse.headers.get('access-control-allow-origin'),origin);
    assert.equal((await fetch(base+'/api/characters',{headers:{origin:'http://untrusted'}})).status,403);
    await new Promise<void>((resolve,reject)=>{
      const req=request(base+'/room',{headers:{Connection:'Upgrade',Upgrade:'websocket'}},res=>{assert.equal(res.statusCode,503);res.resume();resolve();});
      req.on('error',reject);req.end();
    });
    const bounds={minX:-40,maxX:40,minZ:-40,maxZ:40},spawn={x:0,z:0};
    const mesh={surface:'sidewalk',positions:[-40,0,-40,40,0,-40,40,0,40,-40,0,40],indices:[0,1,2,0,2,3]};
    const city={id:'startup',version:1,bounds,roads:[],chunks:[{meshes:[mesh]}]};
    let yields=0;
    const nav=await createNpcNavigationAsync(city,{spawn,blockers:[]},[],async()=>{
      yields++;await setImmediate();assert.equal((await fetch(base+'/healthz')).status,200);
    });
    assert.ok(yields>0);
    const sync=createNpcNavigation(city,{spawn,blockers:[]},[]);
    assert.equal(nav.version,sync.version);assert.deepEqual(nav.findFoot(4,4)?.point,sync.findFoot(4,4)?.point);
    const state={tick:0,attempts:0,replacements:0,crowds:[],scenarios:[{id:'npc/test',seed:42,personality:0,anchor:'p/0/0',home:'p/0/0',startTick:0,navigation:nav.version}]};
    const a=createNpcAuthority(nav,0),b=createNpcAuthority(sync,0);b.restore(state);
    await a.restoreAsync(state,async()=>{await setImmediate();assert.equal((await fetch(base+'/healthz')).status,200);});
    assert.deepEqual(a.checkpoint(),b.checkpoint());assert.deepEqual(a.presentation(0,0),b.presentation(0,0));
    startup.handoff();
    room=startRoom({bounds,spawn,baseHeight:0,slopeX:0,floors:[],blockers:[]},'startup/1',port,[origin],async()=>false,'127.0.0.1',[],[],undefined,undefined,undefined,undefined,undefined,api,startup.server);
    assert.equal(room.server.address()&&typeof room.server.address()==='object'?(room.server.address() as {port:number}).port:0,port);
    assert.equal(await(await fetch(base+'/healthz')).text(),'ok');
    assert.equal((await fetch(base+'/readyz')).status,200);
    assert.equal(await(await fetch(base+'/api/characters',{headers:{origin}})).text(),'characters');
  } finally {
    if(room)await room.close();
    else await new Promise<void>(resolve=>startup.server.close(()=>resolve()));
  }
});
