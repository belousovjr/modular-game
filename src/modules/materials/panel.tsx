import { useSyncExternalStore } from 'react';
import { DataList, Flex, Text } from '@radix-ui/themes';
import type { createMaterials } from './resources.ts';

export function MaterialsPanel(api: ReturnType<typeof createMaterials>) {
  const state = useSyncExternalStore(api.subscribe, api.getSnapshot);
  return <Flex direction="column" gap="2">
    <DataList.Root>
      <DataList.Item><DataList.Label>Материалы</DataList.Label><DataList.Value>{state.materials}</DataList.Value></DataList.Item>
      <DataList.Item><DataList.Label>Общие текстуры</DataList.Label><DataList.Value>{state.textures}</DataList.Value></DataList.Item>
      <DataList.Item><DataList.Label>Загрузка</DataList.Label><DataList.Value>{state.loading}</DataList.Value></DataList.Item>
      <DataList.Item><DataList.Label>Ошибки</DataList.Label><DataList.Value>{state.failed}</DataList.Value></DataList.Item>
      <DataList.Item><DataList.Label>RGBA + mipmaps</DataList.Label><DataList.Value>≈ {Math.round(state.estimatedBytes / 1024)} КиБ</DataList.Value></DataList.Item>
    </DataList.Root>
    <Text size="1" color="gray">Повтор фактуры: 2 м. Детализация — через mipmaps. Оценка памяти без накладных расходов драйвера; mipmaps не выгружают текстуры.</Text>
    {state.errors.map(error => <Text key={error} role="alert" color="red" size="2">{error}</Text>)}
  </Flex>;
}
