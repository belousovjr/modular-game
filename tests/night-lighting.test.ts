import {test} from 'node:test';import assert from 'node:assert/strict';
import {bakeNightField} from '../src/modules/night-lighting/field.ts';
import {activeStreetLampPhases, streetLampPhase} from '../src/modules/materials/street-lamp.ts';
import {citySource} from '../src/modules/world/city.ts';

test('night field separates near lamps, grouped far glow and every building without per-frame lights',()=>{
  const bounds={minX:-100,maxX:100,minZ:-100,maxZ:100};
  const lamps=Array.from({length:20},(_,i)=>({id:`lamp/${i}`,street:i<10?'south':'north',x:(i%10)*4-20,y:5,z:i<10?-30:30}));
  const buildings=[{id:'building',minX:-5,maxX:5,minZ:-5,maxZ:5,minY:0,maxY:25,outline:[[-5,-5],[5,-5],[5,5],[-5,5]]}];
  const a=bakeNightField(lamps,buildings,bounds,streetLampPhase,128),b=bakeNightField(lamps,buildings,bounds,streetLampPhase,128);
  assert.deepEqual(a.data,b.data);assert.equal(a.lamps,20);assert.equal(a.maxGroup,10);assert.equal(a.groups,2);assert.equal(a.buildings,1);
  const sample=(x:number,z:number,c:number,far=false)=>a.data[((Math.floor((z+100)/200*128)+(far?128:0))*128+Math.floor((x+100)/200*128))*4+c];
  const phase = streetLampPhase(-20,-30);
  assert.ok(sample(-20,-30,phase)>sample(-20,-65,phase));
  const lampGlow = (far: boolean) => [0,1,2].reduce((sum,c)=>sum+sample(-2,-15,c,far),0);
  assert.ok(lampGlow(true)>lampGlow(false));
  assert.ok(sample(5,0,3)>sample(40,0,3));
  assert.equal(sample(5,0,3),sample(5,0,3,true));
  assert.throws(()=>bakeNightField([],[],bounds,streetLampPhase,0));
  const dark=bakeNightField([],[],bounds,streetLampPhase,16);assert.ok(dark.data.every(v=>v===0));
});

test('the full city night field is bounded and clusters lamps at most ten to one',()=>{
  const names=new Map(citySource.roads.map(r=>[r.id,r.name||r.id]));
  const lamps=citySource.placements.filter(p=>p.templateId==='world/lamp').map(p=>({id:p.key,street:names.get(p.key.split('/').slice(2,-2).join('/'))??p.key,x:p.position[0]+1.5*Math.cos(p.rotation[1]),y:p.position[1]+4.125,z:p.position[2]-1.5*Math.sin(p.rotation[1])}));
  const field=bakeNightField(lamps,citySource.colliders,citySource.bounds,streetLampPhase,256);
  assert.ok(field.lamps>100&&field.groups<field.lamps/2);assert.ok(field.maxGroup<=10);assert.equal(field.buildings,citySource.colliders.length);assert.equal(field.data.byteLength,256*256*8);
});


test('street lamps use three stable cohorts with binary dusk and dawn thresholds', () => {
  const counts = [0,0,0];
  for (const lamp of citySource.placements.filter(p=>p.templateId==='world/lamp')) {
    const [x,,z] = lamp.position, yaw = lamp.rotation[1];
    counts[streetLampPhase(x+1.5*Math.cos(yaw),z-1.5*Math.sin(yaw))]++;
  }
  assert.ok(counts.every(count=>count>200));
  for (const [night, active] of [[0,0],[.349,0],[.35,1],[.499,1],[.5,2],[.649,2],[.65,3],[1,3]]) {
    assert.equal(activeStreetLampPhases(night), active);
  }
});
