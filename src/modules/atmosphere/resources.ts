import {MeshBuilder} from '@babylonjs/core/Meshes/meshBuilder.js';
import {ShaderMaterial} from '@babylonjs/core/Materials/shaderMaterial.js';
import {Texture} from '@babylonjs/core/Materials/Textures/texture.js';
import {Vector3} from '@babylonjs/core/Maths/math.vector.js';
import {Color3,Color4} from '@babylonjs/core/Maths/math.color.js';
import {Observable} from '@babylonjs/core/Misc/observable.js';
import {Scene} from '@babylonjs/core/scene.js';
import type {Scope} from '../../core/modules.ts';
import type {lightingModule} from '../lighting/index.ts';
import type {materialsModule} from '../materials/index.ts';

const smooth=(a:number,b:number,x:number)=>{const t=Math.max(0,Math.min(1,(x-a)/(b-a)));return t*t*(3-2*t);};
export function atmosphereColors(hour:number){
  if(!Number.isFinite(hour)||hour<0||hour>=24)throw new Error('Invalid atmosphere hour');
  const height=Math.sin((hour-6)*Math.PI/12),day=smooth(-.15,.2,height),dusk=(1-smooth(.02,.3,Math.abs(height)))*.65;
  return {day,night:1-smooth(-.12,.15,height),
    zenith:Color3.Lerp(Color3.FromHexString('#071322'),Color3.FromHexString('#347db3'),day),
    horizon:Color3.Lerp(Color3.Lerp(Color3.FromHexString('#17283c'),Color3.FromHexString('#b4cbd4'),day),Color3.FromHexString('#ce9a81'),dusk),
    density:.0013+.00035*(1-day)};
}
const vertex=`precision highp float;attribute vec3 position;uniform mat4 worldViewProjection;varying vec3 vRay;
void main(){vRay=position;gl_Position=worldViewProjection*vec4(position,1.);}`;
const fragment=`precision highp float;varying vec3 vRay;uniform vec3 zenith,horizon,sunDirection;uniform float daylight;uniform sampler2D moon;
void main(){
 vec3 ray=normalize(vRay);float above=smoothstep(0.,.35,ray.y);
 vec3 color=mix(horizon,zenith,pow(above,.65));
 float sunDot=dot(ray,sunDirection);
 color+=vec3(1.,.76,.43)*pow(max(0.,sunDot),100.)*.22*daylight;
 float sunDisc=smoothstep(.99987,.99991,sunDot)*step(0.,sunDirection.y);
 color=mix(color,vec3(1.,.94,.74),sunDisc);
 vec3 moonDir=-sunDirection;float moonDot=dot(ray,moonDir);
 if(moonDot>.9997&&moonDir.y>0.){
   vec3 right=normalize(cross(vec3(0.,1.,.001),moonDir)),up=cross(moonDir,right);
   vec2 uv=vec2(dot(ray,right),dot(ray,up))/.028+.5;
   vec2 disc=(uv-.5)*2.;float r=dot(disc,disc);
   float mask=(1.-smoothstep(.94,1.,r))*(1.-daylight*.85);
   vec3 lunar=texture2D(moon,vec2(.5+asin(clamp(disc.x,-1.,1.))/6.28318,.5+asin(clamp(disc.y,-1.,1.))/3.14159)).rgb;
   color=mix(color,lunar*1.3,mask);
 }
 if(daylight<.99){vec2 angles=vec2(atan(ray.z,ray.x)*180.,asin(ray.y)*180.),cell=floor(angles),point=fract(angles)-.5;
 float star=step(.998,fract(sin(dot(cell,vec2(127.1,311.7)))*43758.5453))*(1.-smoothstep(.003,.02,dot(point,point)));
 color+=vec3(.45,.54,.67)*star*(1.-daylight)*smoothstep(.05,.3,ray.y);}
 if(ray.y<=0.)color=horizon;
 gl_FragColor=vec4(color,1.);
}`;

export function createAtmosphere(scene:Scene,lighting:ReturnType<typeof lightingModule.setup>,materials:ReturnType<typeof materialsModule.setup>,onFrame:Observable<number>,scope:Scope){
  const old={mode:scene.fogMode,density:scene.fogDensity,color:scene.fogColor.clone(),clear:scene.clearColor.clone()};
  scope.onDispose(()=>{scene.fogMode=old.mode;scene.fogDensity=old.density;scene.fogColor.copyFrom(old.color);scene.clearColor.copyFrom(old.clear);materials.setNightFactor(null);});
  const sky=MeshBuilder.CreateSphere('atmosphere/sky',{diameter:20000,segments:16},scene);scope.onDispose(()=>sky.dispose());
  sky.infiniteDistance=true;sky.isPickable=false;sky.alwaysSelectAsActiveMesh=true;sky.metadata={shadowCaster:false};
  const shader=new ShaderMaterial('atmosphere/sky',scene,{vertexSource:vertex,fragmentSource:fragment},{attributes:['position'],uniforms:['worldViewProjection','zenith','horizon','sunDirection','daylight'],samplers:['moon']});scope.onDispose(()=>shader.dispose());
  shader.backFaceCulling=false;shader.disableDepthWrite=true;shader.fogEnabled=false;sky.material=shader;
  const changed=new Observable<void>();let stopped=false,playing=true,elapsed=0,loaded=0;const errors:string[]=[];
  scope.onDispose(()=>{stopped=true;changed.clear();});
  const sunDirection=Vector3.Up();
  let snapshot:Readonly<{playing:boolean;hour:number;loaded:number;errors:readonly string[]}>=Object.freeze({playing,hour:lighting.getSettings().hour,loaded,errors:[] as readonly string[]});
  function publish(){if(stopped)return;snapshot=Object.freeze({playing,hour:lighting.getSettings().hour,loaded,errors:Object.freeze([...errors])});changed.notifyObservers();}
  for(const [name,file]of [['moon','moon.webp']]){
    const texture=new Texture(`${import.meta.env?.BASE_URL??'/'}textures/atmosphere/${file}`,scene,false,true,Texture.TRILINEAR_SAMPLINGMODE,()=>{loaded++;publish();},()=>{errors.push(`Не загрузилась текстура ${file}`);publish();});
    scope.onDispose(()=>texture.dispose());texture.wrapU=texture.wrapV=Texture.CLAMP_ADDRESSMODE;shader.setTexture(name,texture);
  }
  function update(){
    const colors=atmosphereColors(lighting.getSettings().hour);
    sunDirection.copyFrom(lighting.getSunLight().direction).negateInPlace();
    shader.setVector3('sunDirection',sunDirection);shader.setColor3('zenith',colors.zenith);shader.setColor3('horizon',colors.horizon);shader.setFloat('daylight',colors.day);
    scene.fogMode=Scene.FOGMODE_EXP2;scene.fogDensity=colors.density;scene.fogColor.copyFrom(colors.horizon);scene.clearColor=new Color4(colors.horizon.r,colors.horizon.g,colors.horizon.b,1);
    materials.setNightFactor(colors.night);publish();
  }
  update();scope.onDispose(lighting.subscribe(update));
  const frame=onFrame.add(delta=>{if(!playing)return;elapsed+=delta;if(elapsed>=250){const advance=elapsed;elapsed=0;lighting.setSettings({hour:(lighting.getSettings().hour+advance*24/1200000)%24});}});scope.onDispose(()=>onFrame.remove(frame));
  return {getSnapshot:()=>snapshot,subscribe(listener:()=>void){if(stopped)throw new Error('Атмосфера остановлена');const o=changed.add(listener);return()=>{changed.remove(o);};},setPlaying(value:boolean){if(stopped)throw new Error('Атмосфера остановлена');playing=value;elapsed=0;publish();}};
}
