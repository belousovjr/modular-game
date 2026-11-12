import { GripHorizontal, X } from 'lucide-react';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { Button, Card, Flex, IconButton, Tooltip } from '@radix-ui/themes';
import { readWindow, writeWindow } from './window-settings.ts';
import type { Panel, Panels } from './panels.ts';

export function PanelWindow({ panel, panels, host }: { panel: Panel; panels: Panels; host: RefObject<HTMLElement | null> }) {
  const storageId = `details-${panel.id}`;
  const element = useRef<HTMLElement>(null);
  const handle = useRef<HTMLButtonElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [position, setPosition] = useState(() => readWindow(storageId).position);
  function move(left: number, top: number) {
    if (!host.current || !element.current) return;
    const next = {
      left: Math.max(0, Math.min(left, host.current.clientWidth - element.current.offsetWidth)),
      top: Math.max(0, Math.min(top, host.current.clientHeight - element.current.offsetHeight)),
    };
    setPosition(next);
    writeWindow(storageId, { position: next });
  }
  useEffect(() => {
    if (!panel.open || !host.current) return;
    handle.current?.focus();
    const observer = new ResizeObserver(() => {
      if (element.current) move(element.current.offsetLeft, element.current.offsetTop);
    });
    observer.observe(host.current);
    return () => observer.disconnect();
  }, [panel.open, host]);
  function close() {
    panels.close(panel.id);
    (document.getElementById(`details-${panel.id}`) ?? document.getElementById('modules-trigger'))?.focus();
  }
  return <Card asChild>
    <section id={`${panel.id}-window`} ref={element} className="info-panel" style={position} hidden={!panel.open}
      role="dialog" aria-modal="false" aria-label={panel.title}
      onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }}>
      <Flex direction="column" gap="3">
        <Flex className="panel-heading" justify="between" align="center" gap="3">
          <Tooltip content="Перетащите или используйте стрелки для перемещения">
          <Button ref={handle} variant="ghost" className="panel-handle"
            onPointerDown={event => {
              if (event.button !== 0 || !element.current) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              drag.current = { x: event.clientX, y: event.clientY, left: element.current.offsetLeft, top: element.current.offsetTop };
            }}
            onPointerMove={event => { if (drag.current) move(drag.current.left + event.clientX - drag.current.x, drag.current.top + event.clientY - drag.current.y); }}
            onLostPointerCapture={() => { drag.current = null; }}
            onKeyDown={event => {
              const directions: Record<string, readonly [number, number]> = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] };
              const direction = directions[event.key];
              if (direction && element.current) { event.preventDefault(); move(element.current.offsetLeft + direction[0], element.current.offsetTop + direction[1]); }
            }}><GripHorizontal size={16} aria-hidden="true" />{panel.title}</Button>
          </Tooltip>
          <Tooltip content="Закрыть"><IconButton variant="soft" onClick={close} aria-label={`Закрыть: ${panel.title}`}><X size={16} aria-hidden="true" /></IconButton></Tooltip>
        </Flex>
        {panel.content}
      </Flex>
    </section>
  </Card>;
}
