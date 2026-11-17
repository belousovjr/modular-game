import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createCameraGroundSweep} from '../src/modules/player-control/camera-ground.ts';

test('low camera orbit shortens before flat ground and restores the full horizontal orbit',()=>{
  const sweep=createCameraGroundSweep({baseHeight:0,slopeX:0,bounds:{minX:-100,maxX:100,minZ:-100,maxZ:100},spawn:{x:0,z:0},blockers:[],floors:[]});
  assert.ok(Math.abs(sweep({x:0,y:1.2,z:0},{x:0,y:-6,z:3})-(1.2-.22)/6)<1e-9);
  assert.equal(sweep({x:0,y:1.2,z:0},{x:0,y:0,z:6}),1);
});

test('camera sweep uses sloping terrain across cells and raised sidewalks, ignoring overhead surfaces',()=>{
  const world={baseHeight:-40,slopeX:0,bounds:{minX:-100,maxX:100,minZ:-100,maxZ:100},spawn:{x:0,z:0},blockers:[],floors:[],triangles:[[0,0,-20,40,4,-20,0,0,20],[0,10,-20,40,10,-20,0,10,20]]};
  const sweep=createCameraGroundSweep(world);
  const fraction=sweep({x:15,y:3,z:0},{x:4,y:-3,z:0});
  assert.ok(fraction>0&&fraction<1);
  assert.ok(Math.abs(3-3*fraction-(15+4*fraction)*.1-.22*Math.hypot(1,.1))<1e-9);
  assert.equal(sweep({x:80,y:3,z:0},{x:4,y:-3,z:0}),1);
  const sidewalk=createCameraGroundSweep({...world,baseHeight:0,triangles:[],floors:[{minX:-2,maxX:2,minZ:-2,maxZ:2,elevation:.18}]});
  assert.ok(Math.abs(sidewalk({x:0,y:1.38,z:0},{x:0,y:-3,z:1})-.98/3)<1e-9);
});
