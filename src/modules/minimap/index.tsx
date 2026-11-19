import { useEffect, useRef, useState } from 'react';
import { Card, Flex, Text } from '@radix-ui/themes';
import { Navigation2 } from 'lucide-react';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { defineModule } from '../../core/context.ts';
import { objectRenderingModule } from '../object-rendering/index.ts';
import { worldModule, type WorldMap } from '../world/index.ts';
import { bakeMap, DISPLAY_SIZE, makeStreetReader, mapHeading } from './map.ts';
import './minimap.css';

type Draw = (x:number,z:number,heading:number) => void;
type Subscribe = (draw: Draw) => () => void;

function Minimap({map,subscribe}: {map: WorldMap; subscribe: Subscribe}) {
  const hud = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [label,setLabel] = useState({street:'',address:''});
  useEffect(() => {
    const element = hud.current;
    if (!element) return;
    const listeners = new AbortController();
    const options = { capture: true, passive: true, signal: listeners.signal };
    // The overlay lets pointer events reach the scene, so track hover by position.
    window.addEventListener('pointermove', event => {
      if (event.pointerType === 'touch') return;
      const {left,right,top,bottom} = element.getBoundingClientRect();
      element.toggleAttribute('data-hovered',
        event.clientX >= left && event.clientX < right && event.clientY >= top && event.clientY < bottom);
    }, options);
    window.addEventListener('pointerout', event => {
      if (!event.relatedTarget) element.removeAttribute('data-hovered');
    }, options);
    return () => listeners.abort();
  }, []);
  useEffect(() => {
    const context = canvas.current?.getContext('2d');
    if (!context) return;
    const draw = bakeMap(map);
    if (!draw) return;
    const read = makeStreetReader(map);
    let previousX=Infinity, previousZ=Infinity, previousLabel={street:'',address:''};
    return subscribe((x,z,heading) => {
      draw(context,x,z,heading);
      if (Math.hypot(x-previousX,z-previousZ) < 8) return;
      previousX=x; previousZ=z;
      const {street,address} = read(x,z);
      const description = address ? `${address.estimated?'≈ ':''}${address.number} ${address.street}` : '';
      if (street !== previousLabel.street || description !== previousLabel.address) {
        previousLabel={street,address:description};
        setLabel(previousLabel);
      }
    });
  }, [map,subscribe]);
  return <Flex ref={hud} className="minimap-hud" direction="column" gap="2">
    <Card size="1">
      <Flex direction="column">
        {label.street && <Text size="1" weight="bold">{label.street}</Text>}
        {label.address && <Text size="1" color="amber">{label.address}</Text>}
        <Text size="1" color="gray">© OpenStreetMap contributors</Text>
      </Flex>
    </Card>
    <div className="minimap">
      <canvas ref={canvas} width={DISPLAY_SIZE} height={DISPLAY_SIZE} role="img"
        aria-label="Мини-карта района. Направление взгляда сверху, светлые линии — улицы, светлые точки — двери." />
      <Navigation2 className="minimap-marker" size={22} fill="currentColor" aria-hidden="true" />
    </div>
  </Flex>;
}

export const minimapModule = defineModule({
  id:'minimap', title:'Мини-карта', category:'Окружение', requires:{world:worldModule,rendering:objectRenderingModule},
  setup({core,deps,scope}) {
    const map = deps.world.getMap();
    const forward = Vector3.Zero();
    const axis = Vector3.Forward(core.scene.useRightHandedSystem);
    let draw: Draw | undefined;
    let lastX=Infinity, lastZ=Infinity, heading=0;
    const subscribe: Subscribe = callback => {
      draw=callback;
      lastX=Infinity;
      return () => { if (draw===callback) draw=undefined; };
    };
    const observer = core.scene.onBeforeRenderObservable.add(() => {
      if (!draw) return;
      const camera=core.scene.activeCamera;
      if (!camera) return;
      const point=deps.rendering.getDistanceOrigin();
      if (!point) return;
      camera.getViewMatrix();
      camera.getDirectionToRef(axis,forward);
      const nextHeading=mapHeading(forward.x,forward.z,heading);
      if (point.x===lastX && point.z===lastZ && nextHeading===heading) return;
      lastX=point.x;lastZ=point.z;heading=nextHeading;
      draw(lastX,lastZ,heading);
    });
    scope.onDispose(() => { draw=undefined; core.scene.onBeforeRenderObservable.remove(observer); });
    scope.onDispose(core.panels.register('minimap','Мини-карта',<Minimap map={map} subscribe={subscribe} />,true));
    return {};
  },
});
