import {useSyncExternalStore} from 'react';
import {Checkbox,Flex,Text} from '@radix-ui/themes';
import {defineModule} from '../../core/context.ts';
import {lightingModule} from '../lighting/index.ts';
import {materialsModule} from '../materials/index.ts';
import {createAtmosphere} from './resources.ts';
function AtmospherePanel({api}:{api:ReturnType<typeof createAtmosphere>}){
 const s=useSyncExternalStore(api.subscribe,api.getSnapshot);
 return <Flex direction="column" gap="2"><Text as="label"><Flex gap="2" align="center"><Checkbox checked={s.playing} onCheckedChange={v=>api.setPlaying(v===true)}/>Движение солнца и луны</Flex></Text><Text size="2">Сутки за 20 минут. Время можно выбрать в панели освещения.</Text><Text size="1">Ниже горизонта — цвет дымки. Луна: NASA LRO.</Text>{s.errors.map(e=><Text key={e} color="red">{e}</Text>)}</Flex>;
}
export const atmosphereModule=defineModule({id:'atmosphere',title:'Небо и атмосфера',category:'Окружение',requires:{lighting:lightingModule,materials:materialsModule},setup({core,deps,scope}){
 const api=createAtmosphere(core.scene,deps.lighting,deps.materials,core.onFrame,scope);scope.onDispose(core.panels.register('atmosphere','Небо и атмосфера',<AtmospherePanel api={api}/>));return api;
},test:{durationSeconds:8,setup({deps,api,scope,report}){
 const previous=deps.lighting.getSettings(),playing=api.getSnapshot().playing;api.setPlaying(false);
 scope.onDispose(()=>{deps.lighting.setSettings(previous);api.setPlaying(playing);});
 return progress=>{deps.lighting.setSettings({hour:progress*24%24});const s=api.getSnapshot();report({hour:s.hour,texturesReady:s.loaded,errors:s.errors.length});};
}}});
