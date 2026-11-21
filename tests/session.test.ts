import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalSession } from '../src/simulation/session.ts';

test('a local session caches published state and isolates queued commands across channels', async () => {
  const session = createLocalSession();
  let state = { tick: 0 };
  const actor = session.connect<{ target: { x: number } }, typeof state>(
    'hero', () => state, command => ({ accepted: true, reason: JSON.stringify(command) }), {},
  );
  const car = session.connect('car', () => ({ tick: 0, leftDoor: 0 }),
    () => ({ accepted: true, reason: 'ok' }), {});
  const command = { target: { x: 1 } };
  const receipt = actor.send(command);
  command.target.x = 9;
  state = { tick: 1 };
  assert.deepEqual(session.snapshot(), { hero: { tick: 0 }, car: { tick: 0, leftDoor: 0 } });
  actor.deliver(1);
  actor.publish();
  assert.equal((await receipt).reason, '{"target":{"x":1}}');
  const pending = car.send({});
  car.close();
  assert.equal((await pending).reason, 'closed');
  assert.deepEqual(session.snapshot(), { hero: { tick: 1 } });
  actor.close();
});
