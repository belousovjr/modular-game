import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'vite';

test('initial unavailable room retries before welcome, but authorization denial stops retries',async context=>{
  const vite=await createServer({configFile:false,plugins:[{name:'headless-door-fixture',enforce:'pre',load(id){if(id.endsWith('/src/modules/building-interiors/index.ts'))return 'export { interpolateDoorPoses, readDoorPoses } from "./headless.ts";';}}],server:{middlewareMode:true},appType:'custom'});
  const original=Object.getOwnPropertyDescriptor(globalThis,'WebSocket');
  const instances:FakeSocket[]=[];
  class FakeSocket {
    static OPEN=1;
    readyState=0;
    onclose:((event:{code:number})=>void)|undefined;
    constructor(){instances.push(this);}
    close(){this.onclose?.({code:1000});}
  }
  let connection:ReturnType<typeof import('../src/modules/simulation/online.ts').createOnlineConnection>|undefined;
  try {
    const {createOnlineConnection}=await vite.ssrLoadModule('/src/modules/simulation/online.ts') as typeof import('../src/modules/simulation/online.ts');
    Object.defineProperty(globalThis,'WebSocket',{configurable:true,writable:true,value:FakeSocket});
    context.mock.timers.enable({apis:['setTimeout']});
    connection=createOnlineConnection({characterId:'test',accessToken:async()=>'',status:()=>{}});
    connection.toggle(true,'test/1');assert.equal(instances.length,1);
    instances[0]!.onclose?.({code:1006});
    context.mock.timers.tick(1000);assert.equal(instances.length,2);
    instances[1]!.onclose?.({code:4003});
    context.mock.timers.tick(10000);assert.equal(instances.length,2);
  } finally {
    connection?.dispose();context.mock.timers.reset();
    if(original)Object.defineProperty(globalThis,'WebSocket',original);else Reflect.deleteProperty(globalThis,'WebSocket');
    await vite.close();
  }
});
