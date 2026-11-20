import {useSyncExternalStore} from 'react';
import {Flex,Text} from '@radix-ui/themes';
import {defineModule} from '../../core/context.ts';
import {lightingModule} from '../lighting/index.ts';
import {materialsModule} from '../materials/index.ts';
import {createAtmosphere} from './resources.ts';
function AtmospherePanel({api}:{api:ReturnType<typeof createAtmosphere>}){
 const s=useSyncExternalStore(api.subscribe,api.getSnapshot);
 return <Flex direction="column" gap="2"><Text size="2">Время и скорость цикла настраиваются в панели освещения.</Text><Text size="1">Ниже горизонта — цвет дымки. Луна: NASA LRO.</Text>{s.errors.map(e=><Text key={e} color="red">{e}</Text>)}</Flex>;
}
export const atmosphereModule=defineModule({id:'atmosphere',title:'Небо и атмосфера',category:'Окружение',requires:{lighting:lightingModule,materials:materialsModule},setup({core,deps,scope}){
 const api=createAtmosphere(core.scene,deps.lighting,deps.materials,scope);deps.lighting.startDefaultCycle();scope.onDispose(core.panels.register('atmosphere','Небо и атмосфера',<AtmospherePanel api={api}/>));return api;
},test:{durationSeconds:8,setup({deps,api,scope,report}){
 deps.lighting.previewCycle(scope);
 return progress=>{deps.lighting.setSettings({hour:progress*24%24});const s=api.getSnapshot();report({hour:s.hour,texturesReady:s.loaded,errors:s.errors.length});};
}}});
