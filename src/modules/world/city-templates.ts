import type {ObjectTemplate} from '../object-templates/index.ts';
import type {GeometryPart} from '../geometry/index.ts';
import {snapCityMeasure,steppedBuildingParts,steppedBuildingCrownParts} from './headless.ts';

const span={default:30,min:.1,max:1000};
export const cityTemplates:readonly ObjectTemplate[]=[
  ...['stone','glass','willis','trump','marina','wrigley','tribune'].map((profile):ObjectTemplate=>({
    id:`city/${profile}`,version:['stone','glass'].includes(profile)?4:5,
    parameters:{width:span,depth:span,height:{default:55,min:3,max:600},foundation:{default:2,min:.1,max:20}},
    build({width,depth,height,foundation}) {
      const surface=profile==='willis'?'city-dark':profile==='stone'||profile==='wrigley'||profile==='tribune'||profile==='marina'?'city-stone':'city-glass';
      const part=(x:number,y:number,z:number,w:number,h:number,d:number,face=surface,angle=0):GeometryPart=>({surface:face,size:[w,h,d],position:[x,y,z],rotation:[0,angle,0]});
      const body=part(0,height/2,0,width,height,depth);
      const foundationPart=part(0,-foundation/2,0,width,foundation,depth,'foundation');
      const crown:GeometryPart[]=[];
      const tiers=steppedBuildingParts(profile,width,depth,height);
      let silhouette:GeometryPart[]=tiers?.map(tier=>({...tier,surface}))??[body];
      if(profile==='willis') {
        crown.push(part(-width/6,height+35,-depth/6,.8,70,.8,'metal'),part(width/6,height+35,depth/6,.8,70,.8,'metal'));
      } else if(profile==='trump') {
        crown.push(part(0,height+24,0,.8,48,.8,'metal'));
      } else if(profile==='marina') {
        silhouette=[{...part(0,height/2,0,width*.96,height,depth*.96),radialSegments:16}];
      }
      for(const p of steppedBuildingCrownParts(profile,width,depth,height))crown.push(part(...p.position,...p.size,profile==='wrigley'?'roof':surface));
      const detail:GeometryPart[]=[];
      if(profile==='marina')for(let y=4;y<height;y+=3.5)detail.push({...part(0,y,0,width,.18,depth,'foundation'),radialSegments:16});
      const foundationNear=profile==='marina'?{...foundationPart,radialSegments:16}:foundationPart;
      const mainParts=[...silhouette,foundationNear,...crown];
      const levels=[{distance:0,parts:[...mainParts,...detail]}];
      if(profile==='marina'){
        const reduced={...part(0,height/2,0,width*.96,height,depth*.96),radialSegments:8};
        levels.push({distance:36,parts:mainParts},{distance:105,parts:[reduced,{...foundationPart,radialSegments:8}]});
      }
      // Stepped landmarks retain their facade dimensions and roof silhouettes at every distance.
      return {hideDistance:profile==='stone'?300:1200,levels};
    },
  })),
  {id:'city/bench',version:1,parameters:{},build:()=>{
    const seat:GeometryPart={surface:'foundation',size:[3,.25,.75],position:[0,.625,0]};
    const legs:GeometryPart[]=[-1,1].map(x=>({surface:'foundation',size:[.5,.5,.5],position:[x,.25,0]}));
    const back:GeometryPart={surface:'metal',size:[3,.5,.25],position:[0,1,-.25]};
    return {hideDistance:85,levels:[{distance:0,parts:[seat,...legs,back]},{distance:22,parts:[seat,...legs]},{distance:50,parts:[{surface:'foundation',size:[3,.75,.75],position:[0,.375,0]}]}]};
  }},
  {id:'city/planter',version:1,parameters:{},build:()=>{
    const walls:GeometryPart[]=[-1,1].flatMap(side=>[
      {surface:'foundation',size:[5,.75,.25],position:[0,.375,side*1.125]},
      {surface:'foundation',size:[.25,.75,2],position:[side*2.375,.375,0]},
    ]);
    const fill:GeometryPart={surface:'terrain',size:[4.5,.5,2],position:[0,.25,0]};
    return {hideDistance:85,levels:[{distance:0,parts:[...walls,fill]},{distance:35,parts:[{surface:'foundation',size:[5,.75,2.5],position:[0,.375,0]}]}]};
  }},
  {id:'city/bollard',version:1,parameters:{},build:()=>{
    const post:GeometryPart={surface:'metal',size:[.25,.75,.25],position:[0,.625,0]};
    const base:GeometryPart={surface:'foundation',size:[.5,.25,.5],position:[0,.125,0]};
    return {hideDistance:60,levels:[{distance:0,parts:[post,base]},{distance:20,parts:[{surface:'metal',size:[.25,1,.25],position:[0,.5,0]}]}]};
  }},
  {id:'city/signal',version:2,parameters:{armLength:{default:4,min:2,max:12}},build:({armLength})=>{
    const pole:GeometryPart={surface:'metal',size:[.25,6.75,.25],position:[0,3.375,0]};
    const arm:GeometryPart={surface:'metal',size:[armLength,.25,.25],position:[-armLength/2,6.625,0]};
    const head:GeometryPart={surface:'signal-body',size:[.5,1.25,.5],position:[-armLength,5.875,0]};
    return {hideDistance:130,levels:[
      {distance:0,parts:[pole,arm,head,...[6.25,5.875,5.5].map((y,i):GeometryPart=>({surface:i===0?'signal-red':'signal-off',size:[.25,.25,.25],position:[-armLength,y,-.375]}))]},
      {distance:40,parts:[pole,arm,head]},
    ]};
  }},
];

// Parts use the quarter-metre module; centres need half a module to align their faces.
export function toCityGrid(template:ObjectTemplate):ObjectTemplate {
  const snap=snapCityMeasure;
  const part=(p:GeometryPart):GeometryPart=>({...p,
    size:[Math.max(.25,snap(p.size[0],.25)),Math.max(.25,snap(p.size[1],.25)),Math.max(.25,snap(p.size[2],.25))],
    position:p.position?[snap(p.position[0],.125),snap(p.position[1],.125),snap(p.position[2],.125)]:undefined,
    rotation:p.rotation?[snap(p.rotation[0],Math.PI/12),snap(p.rotation[1],Math.PI/12),snap(p.rotation[2],Math.PI/12)]:undefined,
  });
  return {...template,build(parameters){const result=template.build(parameters);return {...result,levels:result.levels.map(level=>({...level,parts:level.parts.map(part)}))};}};
}
