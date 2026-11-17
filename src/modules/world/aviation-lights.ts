import {Constants} from '@babylonjs/core/Engines/constants.js';
import {ShaderMaterial} from '@babylonjs/core/Materials/shaderMaterial.js';
import {Mesh} from '@babylonjs/core/Meshes/mesh.js';
import {VertexData} from '@babylonjs/core/Meshes/mesh.vertexData.js';
import type {Scene} from '@babylonjs/core/scene.js';
import type {Scope} from '../../core/modules.ts';
import type {GeometryPart} from '../geometry/index.ts';
import type {CitySource, WorldPlacement} from '../world-generation/index.ts';

export function aviationLightPositions(city:CitySource, partsFor:(placement:WorldPlacement)=>readonly GeometryPart[]) {
  return city.placements.filter(p=>p.parameters.height>=300).flatMap(p=>{
    const [x,y,z]=p.position;
    if(p.templateId!=='city/willis'&&p.templateId!=='city/trump'){
      return [[x,y+p.parameters.height+.15,z]];
    }
    const yaw=p.rotation[1], cos=Math.cos(yaw), sin=Math.sin(yaw);
    return partsFor(p).filter(part=>part.surface==='metal').flatMap(part=>{
      if(!part.position)return [];
      const [dx,dy,dz]=part.position;
      return [[x+dx*cos+dz*sin,y+dy+part.size[1]/2+.15,z-dx*sin+dz*cos]];
    });
  });
}

export function createAviationLights(scene:Scene, owner:Scope, anchors:readonly (readonly number[])[]) {
  const mesh=new Mesh('world/aviation-lights',scene);
  owner.onDispose(()=>mesh.dispose());
  mesh.isPickable=false;
  mesh.metadata={shadowCaster:false};
  mesh.setEnabled(false);
  const data=new VertexData();
  data.positions=[];data.indices=[];data.uvs=[];
  for(const [index,anchor] of anchors.entries()){
    for(let vertex=0;vertex<4;vertex++)data.positions.push(...anchor);
    data.uvs.push(-1,-1,1,-1,1,1,-1,1);
    const first=index*4;
    data.indices.push(first,first+1,first+2,first,first+2,first+3);
  }
  data.applyToMesh(mesh);
  const material=new ShaderMaterial('world/aviation-glow',scene,{
    vertexSource:`
      precision highp float;
      attribute vec3 position;
      attribute vec2 uv;
      uniform mat4 viewProjection, projection;
      uniform vec2 pixel;
      uniform vec3 distanceOrigin;
      varying vec2 offset;
      varying float phase, coverage;
      void main() {
        vec4 clip = viewProjection * vec4(position, 1.0);
        float projectedRadius = 2.0 * projection[1][1] / max(1.0, clip.w) / pixel.y;
        clip.xy += uv * pixel * clamp(projectedRadius, 5.5, 15.0) * clip.w;
        gl_Position = clip;
        offset = uv;
        phase = fract(dot(position.xz, vec2(0.013, 0.031)));
        coverage = 1.0 - smoothstep(1150.0, 1200.0, distance(position, distanceOrigin));
      }`,
    fragmentSource:`
      precision highp float;
      uniform float time;
      varying vec2 offset;
      varying float phase, coverage;
      void main() {
        float radius = length(offset);
        float halo = exp(-radius * radius * 6.0) * (1.0 - smoothstep(0.7, 1.0, radius));
        float core = 1.0 - smoothstep(0.13, 0.33, radius);
        float pulse = fract(time * 0.5 + phase) - 0.5;
        float intensity = 0.12 + 0.88 * exp(-pulse * pulse * 95.0);
        gl_FragColor = vec4(1.0, 0.035, 0.018, coverage * intensity * (0.45 * halo + 0.55 * core));
      }`,
  },{attributes:['position','uv'],uniforms:['viewProjection','projection','pixel','distanceOrigin','time'],needAlphaBlending:true});
  owner.onDispose(()=>material.dispose());
  material.alphaMode=Constants.ALPHA_ADD;
  material.disableDepthWrite=true;
  material.backFaceCulling=false;
  mesh.material=material;
  mesh.freezeWorldMatrix();
  const engine=scene.getEngine();
  const pixel={x:0,y:0};
  let time=0;
  return (origin:{x:number;y:number;z:number}|null)=>{
    mesh.setEnabled(origin!==null);
    if(!origin)return;
    time=(time+engine.getDeltaTime()/1000)%2;
    material.setFloat('time',time);
    pixel.x=2/Math.max(1,engine.getRenderWidth());
    pixel.y=2/Math.max(1,engine.getRenderHeight());
    material.setVector2('pixel',pixel);
    material.setVector3('distanceOrigin',origin);
  };
}
