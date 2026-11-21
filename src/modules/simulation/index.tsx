import type { DoorPose } from '../building-interiors/index.ts';
import { Badge, DataList } from '@radix-ui/themes';
import { useEffect, useState } from 'react';
import { defineModule, type CoreContext, type PlaySession } from '../../core/context.ts';
import type { Scope } from '../../core/modules.ts';
import { createLocalAuthority } from '../../simulation/authority.ts';
import { createLocalSession } from '../../simulation/session.ts';
import { createOnlineConnection } from './online.ts';

function SimulationInfo({ read, onFrame }: {
  read: () => ReturnType<ReturnType<typeof createSimulation>['read']>;
  onFrame: CoreContext['onFrame'];
}) {
  const [snapshot, setSnapshot] = useState(read);
  useEffect(() => {
    const observer = onFrame.add(() => setSnapshot(read()));
    return () => { onFrame.remove(observer); };
  }, [read, onFrame]);
  return <DataList.Root>
      <DataList.Item><DataList.Label>Время</DataList.Label><DataList.Value><Badge color="cyan">{snapshot.seconds.toFixed(1)} s</Badge></DataList.Value></DataList.Item>
      <DataList.Item><DataList.Label>Тик</DataList.Label><DataList.Value><Badge color="violet">{snapshot.tick}</Badge></DataList.Value></DataList.Item>
      <DataList.Item><DataList.Label>Задолженность</DataList.Label><DataList.Value><Badge color="amber">{snapshot.pendingTicks}</Badge></DataList.Value></DataList.Item>
  </DataList.Root>;
}

function createSimulation(onFrame: CoreContext['onFrame'], scope: Scope, play?: PlaySession) {
  const authority = createLocalAuthority();
  const session = createLocalSession();
  const online = createOnlineConnection(play);
  scope.onDispose(online.dispose);
  let localDoors: (() => readonly DoorPose[]) | undefined;
  let map = '';
  let blockers = 0;
  let pending = !!play;
  const observer = onFrame.add(delta => {
    authority.advance(delta);
    online.samplePresentation();
    if (pending) {
      pending = false;
      if (!map || blockers) play?.status('Игровой профиль недоступен.', false);
      else if (!online.endpoint) play?.status('Адрес игрового сервера не настроен.', false);
      else online.toggle(true, map);
    }
  });
  scope.onDispose(() => onFrame.remove(observer));
  const snapshot = () => {
    const actor = online.self();
    return actor ? { tick: actor.tick, seconds: actor.tick / 60, pendingTicks: 0 } : authority.snapshot();
  };
  return {
    read: snapshot,
    api: {
      snapshot: authority.snapshot, session, onlineDayHour: online.dayHour,
      worldSnapshot() {
        const vehicle = online.vehicle();
        return { clock: snapshot(), doors: online.doors() ?? localDoors?.() ?? [], entities: vehicle
          ? Object.fromEntries([...online.latest(), vehicle].map(entity => [entity.id, entity]))
          : session.snapshot() };
      },
      registerDoors(read: () => readonly DoorPose[], owner: Scope) { localDoors = read; owner.onDispose(() => { localDoors = undefined; }); },
      registerSystem(step: (tick: number) => void, owner: Scope) { owner.onDispose(authority.addSystem(step)); },
      enableOnline(world: string, owner: Scope) { map = world; owner.onDispose(() => { map = ''; online.dispose(); }); },
      blockOnline(owner: Scope) { blockers++; online.dispose(); owner.onDispose(() => { blockers--; }); },
      online: { connected: online.connected, vehicle: online.vehicle, displayVehicle: online.displayVehicle, displaySelf: online.displaySelf, doors: online.displayDoors, self: online.self, remote: online.remote, send: online.send, identity: online.identity },
    },
  };
}

export const simulationModule = defineModule({
  id: 'simulation', category: 'Системы', title: 'Симуляция', requires: {},
  setup({ core, scope }) {
    const simulation = createSimulation(core.onFrame, scope, core.play);
    scope.onDispose(core.panels.register('simulation', 'Симуляция',
      <SimulationInfo read={simulation.read} onFrame={core.onFrame} />));
    return simulation.api;
  },
});
