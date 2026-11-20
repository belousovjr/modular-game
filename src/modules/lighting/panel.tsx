import { useSyncExternalStore } from 'react';
import { Button, Flex, Slider, Text } from '@radix-ui/themes';
import { DEFAULT_DAY_SECONDS, MAX_CYCLE_SPEED, type createLighting } from './light.ts';

// Eight keyboard steps per doubling, with a separate zero position for pause.
const STEPS_PER_DOUBLING = 8;
const NORMAL_POSITION = 33;
const LAST_POSITION = NORMAL_POSITION + STEPS_PER_DOUBLING * Math.log2(MAX_CYCLE_SPEED);
const speedFormat = new Intl.NumberFormat('ru', {maximumFractionDigits: 2});
const secondsFormat = new Intl.NumberFormat('ru', {style: 'unit', unit: 'second', maximumFractionDigits: 1});
const minutesFormat = new Intl.NumberFormat('ru', {style: 'unit', unit: 'minute', maximumFractionDigits: 1});

function SpeedControl({api}: {api: ReturnType<typeof createLighting>}) {
  const speed = useSyncExternalStore(api.subscribe, api.getSpeed);
  const position = speed === 0 ? 0 : Math.max(1, Math.round(NORMAL_POSITION + STEPS_PER_DOUBLING * Math.log2(speed)));
  const speedLabel = speed === 0 ? '0× (пауза)' : `${speedFormat.format(speed)}×`;
  const seconds = speed > 0 ? DEFAULT_DAY_SECONDS / speed : 0;
  const duration = seconds < 60 ? secondsFormat.format(seconds) : minutesFormat.format(seconds / 60);
  return <Flex direction="column" gap="2">
    <Text size="2">Скорость времени · {speedLabel}</Text>
    <Slider ref={root => {
      // Themes forwards aria props to the root, while the focusable thumb has role="slider".
      const thumb = root?.querySelector('[role="slider"]');
      thumb?.setAttribute('aria-label', 'Скорость времени');
      thumb?.setAttribute('aria-valuetext', speedLabel);
    }} min={0} max={LAST_POSITION} step={1} value={[position]}
      onValueChange={([value]) => api.setSpeed(value === 0 ? 0 : 2 ** ((value - NORMAL_POSITION) / STEPS_PER_DOUBLING))} />
    <Text size="2">{speed > 0 ? `Сутки за ${duration}.` : 'Текущее время суток зафиксировано.'}</Text>
  </Flex>;
}
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
    <SpeedControl api={api} />
  </Flex>;
}
