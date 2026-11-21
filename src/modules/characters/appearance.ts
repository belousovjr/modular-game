import catalog from '../../../public/models/human/appearance.json' with {type:'json'};

export const bodies=catalog.bodies;
export type Body=keyof typeof bodies;
export const skinColors=[
  {name:'Светлый',color:'#f4c6a8'},
  {name:'Тёплый',color:'#d59b74'},
  {name:'Оливковый',color:'#aa805c'},
  {name:'Смуглый',color:'#956044'},
  {name:'Тёмный',color:'#613e30'},
] as const;
export const hairColors=[
  {name:'Чёрный',color:'#382f2b'},
  {name:'Каштановый',color:'#795038'},
  {name:'Рыжий',color:'#b55b35'},
  {name:'Светлый',color:'#d6b67c'},
  {name:'Седой',color:'#c9c5bf'},
] as const;

export const hairLabels:Readonly<Record<string,string>>={
  none:'Без волос',Buzzed:'Короткая стрижка',SimpleParted:'Пробор',BuzzedFemale:'Короткая стрижка',Buns:'Два пучка',Long:'Длинные',
};
export type Appearance={body:Body;hair:string;beard:boolean;skin:number;hairColor:number};
export const defaultAppearance:Appearance=Object.freeze({body:'male',hair:'SimpleParted',beard:false,skin:1,hairColor:1});
export function changeAppearance(current:Appearance,change:Partial<Appearance>):Appearance {
  const result={...current,...change};
  const body=bodies[result.body];
  if(result.hair!=='none'&&!body.hair.includes(result.hair))result.hair=body.hair[0];
  if(!body.beard)result.beard=false;
  return result;
}

const key='modular-game.character-appearance';
export function readAppearance():Appearance {
  try {
    const value=JSON.parse(localStorage.getItem(key)??'null');
    if(value?.version===1 && (value.body==='male'||value.body==='female') && typeof value.hair==='string' &&
      typeof value.beard==='boolean' && Number.isInteger(value.skin) && skinColors[value.skin] &&
      Number.isInteger(value.hairColor) && hairColors[value.hairColor])
      return changeAppearance(defaultAppearance,{body:value.body,hair:value.hair,beard:value.beard,skin:value.skin,hairColor:value.hairColor});
  } catch { /* Appearance stays editable if storage is unavailable. */ }
  return defaultAppearance;
}

export function saveAppearance(value:Appearance) {
  try {localStorage.setItem(key,JSON.stringify({version:1,...value}));} catch { /* Session only. */ }
}

export function npcAppearance(id:string):Appearance {
  let seed=2166136261;
  for(let i=0;i<id.length;i++)seed=Math.imul(seed^id.charCodeAt(i),16777619);
  const pick=(count:number)=>{
    seed=(Math.imul(seed,1664525)+1013904223)>>>0;
    return Math.floor(seed/4294967296*count);
  };
  const body:Body=pick(2)?'female':'male';
  const variants=['none',...bodies[body].hair];
  return {body,hair:variants[pick(variants.length)],beard:bodies[body].beard&&pick(3)===0,
    skin:pick(skinColors.length),hairColor:pick(hairColors.length)};
}
