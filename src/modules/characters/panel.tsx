import { Badge, DataList, Text } from '@radix-ui/themes';
import { useSyncExternalStore } from 'react';
import type { createCharacterAssets } from './assets.ts';
import manifest from '../../../public/models/human/manifest.json' with { type: 'json' };

export function CharacterPanel({ assets }: { assets: Pick<ReturnType<typeof createCharacterAssets>,'getStatus'|'subscribe'> }) {
  const status=useSyncExternalStore(assets.subscribe,assets.getStatus,assets.getStatus);
  return <DataList.Root>
    <DataList.Item><DataList.Label>Модель</DataList.Label><DataList.Value><Badge color={status.state==='error'?'red':status.state==='ready'?'green':'amber'}>{status.state==='ready'?'Готова':status.state==='error'?'Ошибка загрузки':'Загрузка'}</Badge></DataList.Value></DataList.Item>
    <DataList.Item><DataList.Label>Треугольники</DataList.Label><DataList.Value>{manifest.triangles}</DataList.Value></DataList.Item>
    <DataList.Item><DataList.Label>Материалы / кости</DataList.Label><DataList.Value>{manifest.primitives} / {manifest.joints}</DataList.Value></DataList.Item>
    <DataList.Item><DataList.Label>Анимации</DataList.Label><DataList.Value>Покой, шаг, бег, прыжок, посадка, вождение, выход и ползание</DataList.Value></DataList.Item>
    {status.error && <DataList.Item><DataList.Label>Ошибка</DataList.Label><DataList.Value><Text color="red">{status.error}</Text></DataList.Value></DataList.Item>}
  </DataList.Root>;
}
