import { useSyncExternalStore } from 'react';
import { Button, Flex, Slider, Text } from '@radix-ui/themes';
import type { createLighting } from './light.ts';

export function LightingPanel(api: ReturnType<typeof createLighting>) {
  const { hour } = useSyncExternalStore(api.subscribe, api.getSettings);
  const minutes = Math.round(hour * 60) % 1440;
  const time = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  return <Flex direction="column" gap="3">
    <Text as="label" htmlFor="lighting-time" size="2">Время суток: {time}</Text>
    <Slider id="lighting-time" aria-label="Время суток" min={0} max={1439} step={1} value={[minutes]}
      onValueChange={([value]) => api.setSettings({ hour: value / 60 })} />
    <Flex gap="2" wrap="wrap">
      <Button variant="soft" onClick={() => api.setSettings({ hour: 8 })}>Утро</Button>
      <Button variant="soft" onClick={() => api.setSettings({ hour: 12 })}>День</Button>
      <Button variant="soft" onClick={() => api.setSettings({ hour: 18 })}>Вечер</Button>
      <Button variant="soft" onClick={() => api.setSettings({ hour: 0 })}>Ночь</Button>
    </Flex>
    <Text size="1" color="gray">Время выбирается вручную. Настройка действует до пересоздания сцены. Теней пока нет.</Text>
  </Flex>;
}
