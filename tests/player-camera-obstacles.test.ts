import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cameraObstacleFraction,createCameraObstacleSweep,recoverCameraRadius} from '../src/modules/player-control/camera-obstacles.ts';

const wall={id:'wall',minX:0,maxX:2,minY:0,maxY:5,minZ:-3,maxZ:3};

test('camera retracts before a wall but can move away or orbit along it inside the clearance',()=>{
  const eye={x:-.1,y:1.2,z:0};
  assert.equal(cameraObstacleFraction(eye,{x:6,y:0,z:0},6,[wall]),0);
  assert.equal(cameraObstacleFraction(eye,{x:-6,y:0,z:0},6,[wall]),1);
  assert.equal(cameraObstacleFraction(eye,{x:0,y:0,z:6},6,[wall]),1);
  const hit=cameraObstacleFraction({...eye,x:-3},{x:6,y:0,z:0},6,[wall]);
  assert.ok(Math.abs(hit*6-2.78)<1e-9);
  assert.equal(cameraObstacleFraction({...eye,x:-3,y:7},{x:6,y:0,z:0},6,[wall]),1);
});

test('camera pulls in immediately and returns smoothly at different frame rates',()=>{
  assert.equal(recoverCameraRadius(6,.05,16),.05);
  function run(frames:number){
    let radius=.05;
    for(let i=0;i<frames;i++)radius=recoverCameraRadius(radius,6,300/frames);
    return radius;
  }
  assert.ok(run(18)>.05&&run(18)<6);
  assert.ok(Math.abs(run(9)-run(72))<1e-9);
  assert.equal(recoverCameraRadius(5.995,6,16),6);
});

test('camera can orbit into a concave facade recess and stops at its visible rear wall',()=>{
  const outline=[[-6,10],[-1,10],[-1,16],[9,16],[9,10],[14,10],[14,28],[-6,28]];
  for(const ring of [outline,[...outline].reverse()]){
    const facade={id:'facade',minX:-6,maxX:14,minY:0,maxY:30,minZ:10,maxZ:28,outline:ring};
    const eye={x:3,y:1.2,z:8};
    assert.equal(cameraObstacleFraction(eye,{x:0,y:0,z:6},6,[facade]),1);
    const fraction=cameraObstacleFraction(eye,{x:0,y:0,z:10},10,[facade]);
    assert.ok(Math.abs(fraction*10-7.78)<1e-8);
  }
});

test('indexed camera sweep matches full collision checks across cells with overlapping blockers',()=>{
  const a={...wall,minX:-33,maxX:-31,minZ:31,maxZ:34};
  const b={...a,id:'overlap',minX:-32.995};
  const c={...wall,id:'large',minX:-1024,maxX:1024,minZ:35,maxZ:1024};
  const blockers=[b,c,a,wall];
  const sweep=createCameraObstacleSweep(blockers);
  for(const target of [{x:-37,y:1.1,z:32},{x:-35,y:2,z:28},{x:-.2,y:1.2,z:0}]){
    for(const arm of [{x:10,y:0,z:0},{x:5,y:1,z:7},{x:0,y:1,z:10},{x:-8,y:0,z:0}]){
      assert.equal(sweep(target,arm,10),cameraObstacleFraction(target,arm,10,blockers));
    }
  }
});
