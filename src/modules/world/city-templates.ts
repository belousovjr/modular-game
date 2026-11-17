import type {ObjectTemplate} from '../object-templates/index.ts';
import type {GeometryPart} from '../geometry/index.ts';

const span={default:30,min:.1,max:1000};
export const cityTemplates:readonly ObjectTemplate[]=[
  ...['stone','glass','willis','trump','marina','wrigley','tribune'].map((profile):ObjectTemplate=>({
    id:`city/${profile}`,version:['stone','glass'].includes(profile)?3:4,
    parameters:{width:span,depth:span,height:{default:55,min:3,max:600},foundation:{default:2,min:.1,max:20}},
    build({width,depth,height,foundation}) {
      const surface=profile==='willis'?'city-dark':profile==='stone'||profile==='wrigley'||profile==='tribune'||profile==='marina'?'city-stone':'city-glass';
      const part=(x:number,y:number,z:number,w:number,h:number,d:number,face=surface,angle=0):GeometryPart=>({surface:face,size:[w,h,d],position:[x,y,z],rotation:[0,angle,0]});
      const body=part(0,height/2,0,width,height,depth);
      const foundationPart=part(0,-foundation/2,0,width,foundation,depth,'foundation');
      const crown:GeometryPart[]=[];
      let silhouette:GeometryPart[]=[body];
      if(profile==='willis') {
        // The landmark's nine bundled tubes retain their silhouette in every LOD.
        silhouette=Array.from({length:9},(_,i)=>{const h=height*[.52,.72,.92,.72,1,.92,.52,.72,.52][i];return part((i%3-1)*width/3,h/2,(Math.floor(i/3)-1)*depth/3,width/3,h,depth/3);});
        crown.push(part(-width/6,height+35,-depth/6,.8,70,.8,'metal'),part(width/6,height+35,depth/6,.8,70,.8,'metal'));
      } else if(profile==='trump'||profile==='tribune'||profile==='wrigley') {
        silhouette=[part(0,height*.27,0,width,height*.54,depth),part(0,height*.69,0,width*.72,height*.3,depth*.72),part(0,height*.92,0,width*.42,height*.16,depth*.42)];
        if(profile==='trump')crown.push(part(0,height+24,0,.8,48,.8,'metal'));
        if(profile==='tribune')for(const x of [-1,1])for(const z of [-1,1])crown.push(part(x*width*.22,height*.97,z*depth*.22,width*.08,height*.12,depth*.08));
        if(profile==='wrigley')crown.push(part(0,height*1.015,0,width*.24,height*.03,depth*.24,'roof'));
      } else if(profile==='marina') {
        silhouette=[{...part(0,height/2,0,width*.96,height,depth*.96),radialSegments:16}];
      }
      const detail:GeometryPart[]=[];
      if(profile==='marina')for(let y=4;y<height;y+=3.5)detail.push({...part(0,y,0,width,.18,depth,'foundation'),radialSegments:16});
      else for(const side of [-1,1])detail.push(part(0,2,side*(depth/2+.04),width*.75,3.6,.12,'city-glass'));
      const foundationNear=profile==='marina'?{...foundationPart,radialSegments:16}:foundationPart;
      const mainParts=[...silhouette,foundationNear,...crown];
      const levels=[
        {distance:0,parts:[...mainParts,...detail]},
        {distance:24,parts:mainParts},
      ];
      if(profile==='marina'){
        const reduced={...part(0,height/2,0,width*.96,height,depth*.96),radialSegments:8};
        levels.push({distance:80,parts:[reduced,{...foundationPart,radialSegments:8}]});
      } else if(profile==='stone'||profile==='glass'){
        levels.push({distance:80,parts:mainParts});
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
  const snap=(value:number,step:number)=>Math.round(value/step)*step;
  const part=(p:GeometryPart):GeometryPart=>({...p,
    size:[Math.max(.25,snap(p.size[0],.25)),Math.max(.25,snap(p.size[1],.25)),Math.max(.25,snap(p.size[2],.25))],
    position:p.position?[snap(p.position[0],.125),snap(p.position[1],.125),snap(p.position[2],.125)]:undefined,
    rotation:p.rotation?[snap(p.rotation[0],Math.PI/12),snap(p.rotation[1],Math.PI/12),snap(p.rotation[2],Math.PI/12)]:undefined,
  });
  return {...template,build(parameters){const result=template.build(parameters);return {...result,levels:result.levels.map(level=>({...level,parts:level.parts.map(part)}))};}};
}
