import {useEffect,useState} from 'react';
import {DataList,Text} from '@radix-ui/themes';
import {KeyboardEventTypes} from '@babylonjs/core/Events/keyboardEvents.js';
import {defineModule} from '../../core/context.ts';
import {charactersModule} from '../characters/index.ts';
import {playerControlModule} from '../player-control/index.ts';
import {worldModule} from '../world/index.ts';
import {geometryModule} from '../geometry/index.ts';
import {createVehicleAuthority,createVehicleConnection,type VehicleSnapshot,type VehicleCommand} from './headless.ts';
import {createCarView} from './view.ts';
import type {CoreContext} from '../../core/context.ts';
const feedback:Record<string,string>={'overturned':'В перевёрнутую машину сесть нельзя','too-far':'Подойдите к водительской двери','blocked-exit':'Слева нет безопасного места для выхода','blocked-door':'Подход к двери перекрыт','unavailable':'Действие сейчас недоступно','driver':'Сначала сядьте за руль'};
const phaseLabels:Record<VehicleSnapshot['phase'],string>={parked:'Припаркована',approaching:'Подход к двери',entering:'Посадка',driving:'За рулём',exiting:'Выход'};
function VehicleInfo({read,onFrame}:{read:()=>{snapshot:VehicleSnapshot;state:string;error:string};onFrame:CoreContext['onFrame']}){
  const [state,setState]=useState(read);
  useEffect(()=>{let elapsed=0;const observer=onFrame.add(delta=>{elapsed+=delta;if(elapsed>=200){elapsed=0;setState(read());}});return()=>{onFrame.remove(observer);};},[read,onFrame]);
  return <><Text as="p" size="2">E — сесть / выйти. O — левая дверь, Shift+O — правая. WASD — ехать и поворачивать. Space — тормоз. Выход доступен и на ходу.</Text><DataList.Root>
    <DataList.Item><DataList.Label>Машина</DataList.Label><DataList.Value>{state.state==='ready'?phaseLabels[state.snapshot.phase]:state.state==='loading'?'Загрузка':'Ошибка'}</DataList.Value></DataList.Item>
    <DataList.Item><DataList.Label>Скорость</DataList.Label><DataList.Value>{(state.snapshot.speed*3.6).toFixed(0)} км/ч</DataList.Value></DataList.Item>
  </DataList.Root>{(state.error||state.snapshot.message)&&<Text as="p" color="red">{state.error||feedback[state.snapshot.message]||state.snapshot.message}</Text>}</>;
}
export const vehiclesModule=defineModule({
  id:'vehicles',title:'Автомобиль',category:'Игра',
  requires:{characters:charactersModule,control:playerControlModule,world:worldModule,geometry:geometryModule},
  setup({core,deps,scope}){
    const authority=createVehicleAuthority(deps.world.collision,deps.characters.snapshot().tick);scope.onDispose(authority.dispose);
    const connection=createVehicleConnection(authority);scope.onDispose(connection.close);
    const view=createCarView(core.scene,deps.geometry,scope);
    const keys=new Set<string>();let sequence=0,lastTick=-1,lastInput='';
    let pendingAction:{action:'enter'|'exit'|'door';side:'left'|'right'}|null=null;
    deps.characters.registerVehicleAuthority(connection.step,scope,()=>{
      keys.clear();pendingAction=null;connection.resetOccupancy();
    });
    const canvas=core.scene.getEngine().getRenderingCanvas();
    const active=()=>!!canvas&&document.activeElement===canvas&&core.scene.activeCamera?.name==='player-camera'&&!document.hidden;
    const clear=()=>keys.clear();window.addEventListener('blur',clear);scope.onDispose(()=>window.removeEventListener('blur',clear));canvas?.addEventListener('blur',clear);scope.onDispose(()=>canvas?.removeEventListener('blur',clear));
    const send=(action:'enter'|'exit'|'door'|'drive',side:'left'|'right'='left')=>{
      const s=connection.snapshot();if(s.tick===lastTick){if(action!=='drive')pendingAction={action,side};return;}lastTick=s.tick;
      const base={vehicleId:s.id,characterId:'local-player',sequence:++sequence,tick:s.tick};
      const command:VehicleCommand=action==='drive'?{...base,type:action,throttle:Number(keys.has('KeyW'))-Number(keys.has('KeyS')),steer:Number(keys.has('KeyA'))-Number(keys.has('KeyD')),brake:!active()||keys.has('Space')}:action==='door'?{...base,type:action,side}:{...base,type:action};
      void connection.send(command);
    };
    const keyboard=core.scene.onKeyboardObservable.add(info=>{
      const e=info.event;if(info.type===KeyboardEventTypes.KEYUP)keys.delete(e.code);
      if(!active()||e.ctrlKey||e.altKey||e.metaKey){clear();return;}
      if(['KeyW','KeyA','KeyS','KeyD','Space'].includes(e.code)){if(info.type===KeyboardEventTypes.KEYDOWN)keys.add(e.code);if(connection.snapshot().driverId)e.preventDefault();}
      if(info.type===KeyboardEventTypes.KEYDOWN&&!e.repeat&&view.status().state==='ready'){
        if(connection.snapshot().phase==='approaching'&&['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code))send('exit');
        if(e.code==='KeyE'){e.preventDefault();send(connection.snapshot().driverId?'exit':'enter');}
        if(e.code==='KeyO'){e.preventDefault();send('door',e.shiftKey?'right':'left');}
      }
    });scope.onDispose(()=>core.scene.onKeyboardObservable.remove(keyboard));
    const update=()=>{
      const s=connection.snapshot();if(!active())clear();
      if(pendingAction&&s.tick>lastTick){const intent=pendingAction;pendingAction=null;send(intent.action,intent.side);}
      if(s.phase==='approaching'&&['KeyW','KeyA','KeyS','KeyD','Space'].some(key=>keys.has(key)))send('exit');
      const input=[...keys].sort().join('/');
      if(s.phase==='driving'&&(s.tick-lastTick>=6||input!==lastInput)&&s.tick>lastTick){send('drive');lastInput=input;}
      view.render(s);
    };
    update();const observer=core.scene.onBeforeRenderObservable.add(update,-1,true);scope.onDispose(()=>core.scene.onBeforeRenderObservable.remove(observer));
    const read=()=>({snapshot:connection.snapshot(),...view.status()});scope.onDispose(core.panels.register('vehicles','Автомобиль',<VehicleInfo read={read} onFrame={core.onFrame}/>));
    return {snapshot:connection.snapshot};
  },
});
