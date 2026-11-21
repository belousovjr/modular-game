import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { openRoomMap, partitionTerrain, type RoomMap } from '../server/terrain-tiles.ts';
import { createCharacterAuthorityFactory } from '../src/modules/characters/headless.ts';
import type { CollisionWorld } from '../src/modules/world/headless.ts';

test('terrain tiles load on demand and preserve traversal and wall collision across a boundary', async () => {
  const world: CollisionWorld = {
    bounds:{minX:100,maxX:150,minZ:-10,maxZ:10}, spawn:{x:126,z:1}, baseHeight:-40, slopeX:0, floors:[],
    triangles:[[100,0,-10,150,0,-10,150,0,10], [100,0,-10,150,0,10,100,0,10]],
    blockers:[{id:'wall',minX:132,maxX:133,minZ:0,maxZ:3,minY:0,maxY:3}],
  };
  const path=await mkdtemp(join(tmpdir(),'room-terrain-'));
  const directory=pathToFileURL(path+'/');
  try {
    const tiles=partitionTerrain(world);
    const manifest: RoomMap={world:'test', collision:{...world, blockers:[],triangles:undefined}, tiles:[...tiles.keys()]};
    await writeFile(new URL('manifest.json',directory),JSON.stringify(manifest));
    await Promise.all([...tiles].map(([key,value])=>writeFile(new URL(key+'.json',directory),JSON.stringify(value))));
    const map=openRoomMap(directory);
    assert.equal(map.loadedTerrainTiles(),0);
    const streamed=createCharacterAuthorityFactory(map.collision,[],undefined,undefined,map.terrain)();
    const full=createCharacterAuthorityFactory(world)();
    assert.equal(map.loadedTerrainTiles(),1);
    for(let tick=1;tick<=120;tick++){
      if(tick%6===1) {
        const input={type:'move',characterId:'local-player',sequence:tick,tick:tick-1,x:1,z:0,run:true,jump:false};
        assert.ok(streamed.receive(input,'local').accepted);
        assert.ok(full.receive(input,'local').accepted);
      }
      streamed.step(tick);
      full.step(tick);
      assert.deepEqual(streamed.snapshot(),full.snapshot());
    }
    assert.ok(full.snapshot().x>128 && full.snapshot().x<132);
    assert.equal(map.loadedTerrainTiles(),2);
  } finally { await rm(path,{recursive:true,force:true}); }
});
