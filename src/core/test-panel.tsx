import { Badge, Button, Card, Flex, IconButton, Progress, Table, Text, Tooltip } from '@radix-ui/themes';
import { useEffect, useRef, useState } from 'react';
import { Square, X } from 'lucide-react';
import { fpsColor } from './fps-color.ts';
import { summarizeTests } from './test-summary.ts';
import type { TestState } from './test-runner.ts';

function FpsValue({ value }: { value: number | null | undefined }) {
  return value == null ? <>—</> : <Badge color={fpsColor(value)} aria-label={`${value.toFixed(1)} FPS`}>{value.toFixed(1)}</Badge>;
}

export function TestPanel({ state, stop }: { state: TestState; stop(): void }) {
  const [dismissed, setDismissed] = useState<TestState['results'] | null>(null);
  const summary = summarizeTests(state.results);
  const overallProgress = state.total ? (state.index - 1 + state.progress) / state.total * 100 : 0;
  const stopButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!state.running) return;
    const previous = document.activeElement;
    stopButton.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [state.running]);
  if (!state.running && (!state.results.length || dismissed === state.results)) return null;
  return <Card className="test-panel" aria-label="Тестирование модулей">
    <Flex direction="column" gap="2">
      {!state.running && <Flex align="center" justify="between" gap="3">
        <Text weight="bold" size="2">Результаты тестирования</Text>
        <Tooltip content="Закрыть результаты"><IconButton id="close-test-results" size="1" variant="ghost" aria-label="Закрыть результаты тестирования" onClick={() => setDismissed(state.results)}><X size={16} aria-hidden="true" /></IconButton></Tooltip>
      </Flex>}
      {state.running && <>
        <Flex align="center" justify="between" gap="3">
          <Text size="2" role="status">{state.title} · {state.index}/{state.total} · {Math.round(state.progress * 100)}%</Text>
          <Button ref={stopButton} id="stop-tests" size="1" color="red" onClick={stop}><Square size={14} aria-hidden="true" />Остановить</Button>
        </Flex>
        <Progress value={state.progress * 100} aria-label={`Прогресс теста: ${state.title}`} />
        <Text size="1" color="gray">Включая 1 с прогрева перед замером</Text>
        {state.total > 1 && <>
          <Text size="2">Общий прогресс · {Math.round(overallProgress)}%</Text>
          <Progress value={overallProgress} aria-label="Общий прогресс тестов" />
        </>}
      </>}
      {state.results.length > 0 && <Table.Root size="1">
        <Table.Header><Table.Row>
          {['Модуль', 'Статус', 'Сред. FPS', 'Мин.', 'Макс.', 'Медиана', 'P95 кадра, мс', 'Кадры / с'].map(label => <Table.ColumnHeaderCell key={label}>{label}</Table.ColumnHeaderCell>)}
        </Table.Row></Table.Header>
        <Table.Body>{state.results.map(result => <Table.Row key={result.id}>
          <Table.RowHeaderCell>{result.title}</Table.RowHeaderCell>
          <Table.Cell>{result.status === 'completed' ? 'Завершён' : result.status === 'cancelled' ? 'Остановлен' : 'Ошибка'}{result.error && <Text as="p" color="red">{result.error}</Text>}</Table.Cell>
          {[result.metrics?.average, result.metrics?.min, result.metrics?.max, result.metrics?.median].map((value, index) => <Table.Cell key={index}><FpsValue value={value} /></Table.Cell>)}
          <Table.Cell>{result.metrics?.p95FrameMs.toFixed(1) ?? '—'}</Table.Cell>
          <Table.Cell>{result.metrics ? `${result.metrics.frames} / ${result.metrics.seconds.toFixed(1)}` : '—'}</Table.Cell>
        </Table.Row>)}</Table.Body>
      </Table.Root>}
      {!state.running && state.results.length > 1 && <Flex id="test-summary" direction="column" gap="1">
        <Text size="2" weight="bold">Сводка</Text>
        <Text size="2">Завершено: {summary.completed} · Остановлено: {summary.cancelled} · Ошибок: {summary.failed}</Text>
        <Text size="2">Всего: {summary.frames} кадров за {summary.seconds.toFixed(1)} с · Средний FPS: <FpsValue value={summary.average} /> · Мин.: <FpsValue value={summary.min} /> · Макс.: <FpsValue value={summary.max} /></Text>
      </Flex>}
    </Flex>
  </Card>;
}
