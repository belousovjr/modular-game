import assert from 'node:assert/strict';
import {test} from 'node:test';
import {getBuildingProfile} from '../src/modules/world/building-profiles.ts';
import {citySource} from '../src/modules/world/city.ts';
import {getWorldMap} from '../src/modules/world/map.ts';

test('each generated door has a local building shell, window grid and entrance', () => {
  const {doors} = getWorldMap(citySource);
  const shapes = new Set<string>();
  const elevators = new Set<number>(), staircases = new Set<number>();
  assert.ok(doors.length > 1000);
  for (const door of doors) {
    const profile = getBuildingProfile(door.id);
    assert.ok(profile, door.id);
    shapes.add(profile.shape);
    assert.ok(profile.width > 0 && profile.depth > 0 && profile.aspectRatio >= 1);
    assert.ok(profile.outline.length >= 3 && profile.facades.length > 0);
    assert.ok(profile.floorCount > 0 && profile.floorHeight > 0);
    const {floorCount, elevatorCount, staircaseCount, outline} = profile;
    const area = Math.abs(outline.reduce((sum, [x,z], i) => {
      const [nextX,nextZ] = outline[(i+1)%outline.length];
      return sum+x*nextZ-nextX*z;
    }, 0))/2;
    assert.equal(elevatorCount, floorCount < 5 ? 0 : Math.min(8, Math.max(1, Math.ceil(area*floorCount/8000))));
    assert.equal(staircaseCount, floorCount === 1 ? 0 : 1+Number(area >= 1500 || elevatorCount >= 4));
    elevators.add(elevatorCount);
    staircases.add(staircaseCount);
    assert.ok(Math.abs(profile.facadeBase + profile.floorCount * profile.floorHeight - (profile.height - .5)) < .02);
    assert.equal(profile.windowSlots, profile.floorCount * profile.facades.reduce((sum, wall) => sum + wall.windowColumns, 0));
    const {entrance} = profile;
    const wall = profile.facades[entrance.wallIndex];
    assert.ok(wall && entrance.width > 0 && entrance.height > 0);
    assert.ok(entrance.offset >= 0 && entrance.offset <= Math.hypot(wall.end[0]-wall.start[0], wall.end[1]-wall.start[1]) + .001);
    const [ox,,oz] = profile.origin, [x,z] = entrance.center;
    const sin = Math.sin(profile.yaw), cos = Math.cos(profile.yaw);
    assert.ok(Math.hypot(door.x-(ox+x*cos+z*sin), door.z-(oz-x*sin+z*cos)) < .002);
  }
  assert.deepEqual(shapes, new Set(['rectangular','round','oval','complex']));
  assert.ok(elevators.has(0) && elevators.has(1) && Math.max(...elevators)>1);
  assert.deepEqual(staircases, new Set([0,1,2]));
  assert.equal(getBuildingProfile('toString'), undefined);
});
