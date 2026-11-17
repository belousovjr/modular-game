import {test} from 'node:test';import assert from 'node:assert/strict';
import {bakeNightField} from '../src/modules/night-lighting/field.ts';
import {citySource} from '../src/modules/world/city.ts';

test('night field separates near lamps, grouped far glow and every building without per-frame lights',()=>{
  const bounds={minX:-100,maxX:100,minZ:-100,maxZ:100};
  const lamps=Array.from({length:20},(_,i)=>({id:`lamp/${i}`,street:i<10?'south':'north',x:(i%10)*4-20,y:5,z:i<10?-30:30}));
  const buildings=[{id:'building',minX:-5,maxX:5,minZ:-5,maxZ:5,minY:0,maxY:25,outline:[[-5,-5],[5,-5],[5,5],[-5,5]]}];
  const a=bakeNightField(lamps,buildings,bounds,128),b=bakeNightField(lamps,buildings,bounds,128);
  assert.deepEqual(a.data,b.data);assert.equal(a.lamps,20);assert.equal(a.maxGroup,10);assert.equal(a.groups,2);assert.equal(a.buildings,1);
  const sample=(x:number,z:number,c:number)=>a.data[(Math.floor((z+100)/200*128)*128+Math.floor((x+100)/200*128))*4+c];
  assert.ok(sample(-20,-30,0)>sample(-20,-65,0));assert.ok(sample(-2,-15,1)>sample(-2,-15,0));
  assert.ok(sample(5,0,2)>sample(40,0,2));assert.ok(a.data.every((v,i)=>i%4!==3||v===255));
  assert.throws(()=>bakeNightField([],[],bounds,0));
  const dark=bakeNightField([],[],bounds,16);assert.ok(dark.data.every((v,i)=>i%4===3?v===255:v===0));
});

test('the full city night field is bounded and clusters lamps at most ten to one',()=>{
  const names=new Map(citySource.roads.map(r=>[r.id,r.name||r.id]));
  const lamps=citySource.placements.filter(p=>p.templateId==='world/lamp').map(p=>({id:p.key,street:names.get(p.key.split('/').slice(2,-2).join('/'))??p.key,x:p.position[0],y:p.position[1]+4.125,z:p.position[2]}));
  const field=bakeNightField(lamps,citySource.colliders,citySource.bounds,256);
  assert.ok(field.lamps>100&&field.groups<field.lamps/2);assert.ok(field.maxGroup<=10);assert.equal(field.buildings,citySource.colliders.length);assert.equal(field.data.byteLength,256*256*4);
});
