import { Badge, Checkbox, Flex, Select, Text } from '@radix-ui/themes';
import { useState, useSyncExternalStore } from 'react';
import type { createCharacterAssets } from './assets.ts';
import {bodies,changeAppearance,hairColors,hairLabels,skinColors,type Appearance} from './appearance.ts';

export function CharacterPanel({assets,initial,onChange}: {
  assets:Pick<ReturnType<typeof createCharacterAssets>,'getStatus'|'subscribe'>;
  initial:Appearance;
  onChange:(appearance:Appearance)=>void;
}) {
  const status=useSyncExternalStore(assets.subscribe,assets.getStatus,assets.getStatus);
  const [appearance,setAppearance]=useState(initial);
  function change(patch:Partial<Appearance>){
    const next=changeAppearance(appearance,patch);
    setAppearance(next);
    onChange(next);
  }
  const body=bodies[appearance.body];
  return <Flex direction="column" gap="3">
    <Flex align="center" justify="between">
      <Text size="2" weight="medium">Внешность</Text>
      <Badge color={status.state==='error'?'red':status.state==='ready'?'green':'amber'}>{status.state==='ready'?'Готова':status.state==='error'?'Ошибка загрузки':'Загрузка'}</Badge>
    </Flex>
    <Choice label="Пол и телосложение" value={appearance.body} options={[
      {value:'male',label:'Мужское'}, {value:'female',label:'Женское'},
    ]} onChange={body=>change({body:body==='female'?'female':'male'})}/>
    <Choice label="Причёска" value={appearance.hair}
      options={['none',...body.hair].map(value=>({value,label:hairLabels[value]??value}))}
      onChange={hair=>change({hair})}/>
    {body.beard&&<Text as="label" size="2">
      <Flex gap="2" align="center">
        <Checkbox checked={appearance.beard} onCheckedChange={beard=>change({beard:beard===true})}/>
        Борода
      </Flex>
    </Text>}
    <Choice label="Цвет кожи" value={String(appearance.skin)}
      options={skinColors.map(({name},i)=>({label:name,value:String(i)}))} onChange={skin=>change({skin:Number(skin)})}/>
    <Choice label="Цвет волос" value={String(appearance.hairColor)}
      options={hairColors.map(({name},i)=>({label:name,value:String(i)}))} onChange={hairColor=>change({hairColor:Number(hairColor)})}/>
    {status.error&&<Text size="2" color="red" role="alert">{status.error}</Text>}
  </Flex>;
}

function Choice({label,value,options,onChange}:{
  label:string;value:string;options:readonly {label:string;value:string}[];onChange:(value:string)=>void;
}) {
  return <Flex direction="column" gap="1">
    <Text size="2">{label}</Text>
    <Select.Root value={value} onValueChange={onChange}>
      <Select.Trigger aria-label={label}/>
      <Select.Content>{options.map(option=><Select.Item key={option.value} value={option.value}>{option.label}</Select.Item>)}</Select.Content>
    </Select.Root>
  </Flex>;
}
