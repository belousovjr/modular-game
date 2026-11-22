import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNpcClock } from '../src/modules/simulation/npc-clock.ts';

test('scheduled NPC time progresses between jittery packets and stops on a stalled room', () => {
  const clock = createNpcClock();
  let tick = clock.sample(600, 0, 0);
  const packets = [[600, 0], [603, 30], [606, 125], [609, 155], [612, 210]];
  for (let now = 10; now <= 240; now += 10) {
    const [serverTick, arrival] = packets.findLast(([, arrival]) => arrival <= now)!;
    const next = clock.sample(serverTick, arrival, now);
    assert.ok(next - tick >= .57 - 1e-9 && next - tick <= .63 + 1e-9);
    tick = next;
  }
  const stalled = clock.sample(612, 210, 2000);
  assert.ok(stalled <= 627);
  assert.equal(clock.sample(612, 210, 2010), stalled);
  clock.reset();
  assert.equal(clock.sample(60, 2020, 2020), 54);
});
