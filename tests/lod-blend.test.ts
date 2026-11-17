import {test} from 'node:test';import assert from 'node:assert/strict';
import {LodBlend} from '../src/modules/object-rendering/lod-blend.ts';
test('LOD blending preserves coverage through interruptions, hides completely and uses visual elapsed time',()=>{
 const blend=new LodBlend(180);blend.select(0);blend.advance(180);blend.select(1);blend.advance(90);
 assert.equal(blend.weights.get(0),.5);assert.equal(blend.weights.get(1),.5);
 blend.select(0);blend.advance(0);assert.equal(blend.weights.get(0),.5);blend.advance(90);assert.equal(blend.weights.get(0),.75);
 blend.select(2);blend.advance(90);assert.ok(Math.abs([...blend.weights.values()].reduce((a,b)=>a+b,0)-1)<1e-10);
 blend.advance(1000);assert.deepEqual([...blend.weights],[[2,1]]);assert.equal(blend.running,false);
 blend.select(null);blend.advance(90);assert.equal(blend.weights.get(2),.5);blend.select(1,true);assert.deepEqual([...blend.weights],[[1,1]]);
 blend.select(null,true);assert.equal(blend.weights.size,0);assert.throws(()=>blend.advance(NaN));assert.throws(()=>new LodBlend(-1));
 for(const fps of [30,60,144]){const b=new LodBlend(180);b.select(0);for(let i=0;i<fps;i++)b.advance(1000/fps);assert.deepEqual([...b.weights],[[0,1]]);assert.equal(b.running,false);}
});
