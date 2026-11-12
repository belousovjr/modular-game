import { Badge, DataList } from '@radix-ui/themes';
import { useEffect, useState } from 'react';
import { defineModule, type CoreContext } from '../../core/context.ts';
import { createLocalAuthority, type Authority } from '../../simulation/authority.ts';

function SimulationInfo({ authority, onFrame }: { authority: Authority; onFrame: CoreContext['onFrame'] }) {
  const [snapshot, setSnapshot] = useState(() => authority.snapshot());
  useEffect(() => {
    const observer = onFrame.add(() => setSnapshot(authority.snapshot()));
    return () => { onFrame.remove(observer); };
  }, [authority, onFrame]);
  return <DataList.Root>
    <DataList.Item><DataList.Label>Время</DataList.Label><DataList.Value><Badge color="cyan">{snapshot.seconds.toFixed(1)} s</Badge></DataList.Value></DataList.Item>
    <DataList.Item><DataList.Label>Тик</DataList.Label><DataList.Value><Badge color="violet">{snapshot.tick}</Badge></DataList.Value></DataList.Item>
    <DataList.Item><DataList.Label>Задолженность</DataList.Label><DataList.Value><Badge color="amber">{snapshot.pendingTicks}</Badge></DataList.Value></DataList.Item>
  </DataList.Root>;
}

export const simulationModule = defineModule({
  id: 'simulation', category: 'Системы', title: 'Симуляция', requires: {},
  setup({ core, scope }) {
    const authority = createLocalAuthority();
    const observer = core.onFrame.add(delta => authority.advance(delta));
    scope.onDispose(() => core.onFrame.remove(observer));
    scope.onDispose(core.panels.register('simulation', 'Симуляция',
      <SimulationInfo authority={authority} onFrame={core.onFrame} />));
    return { snapshot: () => authority.snapshot() };
  },
});
