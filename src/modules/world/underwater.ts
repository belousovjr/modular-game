import {Constants} from '@babylonjs/core/Engines/constants.js';
import {ShaderStore} from '@babylonjs/core/Engines/shaderStore.js';
import {Matrix,Vector3} from '@babylonjs/core/Maths/math.vector.js';
import {PostProcess} from '@babylonjs/core/PostProcesses/postProcess.js';
import type {Camera} from '@babylonjs/core/Cameras/camera.js';
import type {Scene} from '@babylonjs/core/scene.js';
import type {Scope} from '../../core/modules.ts';
import type {CollisionWorld} from './headless.ts';

const shaderName='cityUnderwater';
const maxTriangles=24;
ShaderStore.ShadersStore[shaderName+'FragmentShader']=`
varying vec2 vUV;
uniform sampler2D textureSampler;
uniform vec3 nearRight, nearUp;
uniform float cornerHeight;
uniform int triangleCount;
uniform vec2 waterVertices[${maxTriangles*3}];
float side(vec2 a, vec2 b, vec2 p) {
  vec2 edge=b-a, q=p-a;
  return edge.x*q.y-edge.y*q.x;
}
void main(void) {
  vec4 color=texture2D(textureSampler,vUV);
  vec3 nearOffset=nearRight*vUV.x+nearUp*vUV.y;
  float depth=-(nearOffset.y+cornerHeight);
  if(depth>0.) {
    vec2 point=nearOffset.xz;
    for(int i=0;i<${maxTriangles};i++) {
      if(i>=triangleCount) break;
      vec2 a=waterVertices[3*i], b=waterVertices[3*i+1], c=waterVertices[3*i+2];
      float x=side(a,b,point), y=side(b,c,point), z=side(c,a,point);
      if(min(x,min(y,z))>=0.||max(x,max(y,z))<=0.) {
        float wet=smoothstep(0.,.012,depth);
        float haze=.42+.18*depth/(depth+2.);
        vec3 tinted=mix(color.rgb*vec3(.74,.97,1.),vec3(.045,.24,.28),haze);
        color.rgb=mix(color.rgb,tinted,wet);
        break;
      }
    }
  }
  gl_FragColor=color;
}`;

export function createUnderwaterView(scene:Scene,water:NonNullable<CollisionWorld['water']>,scope:Scope) {
  const triangles=water.triangles.map(([ax,,az,bx,,bz,cx,,cz])=>({
    ax,az,bx,bz,cx,cz,
    minX:Math.min(ax,bx,cx),maxX:Math.max(ax,bx,cx),
    minZ:Math.min(az,bz,cz),maxZ:Math.max(az,bz,cz),
  })).filter(t=>(t.bx-t.ax)*(t.cz-t.az)!==(t.bz-t.az)*(t.cx-t.ax));
  const engine=scene.getEngine(),inverse=Matrix.Identity();
  const corner=Vector3.Zero(),right=Vector3.Zero(),up=Vector3.Zero(),farCorner=Vector3.Zero();
  const vertices:number[]=[];
  let post:PostProcess|undefined,attached:Camera|undefined;

  const observer=scene.onBeforeCameraRenderObservable.add(camera=>{
    camera.getTransformationMatrix().invertToRef(inverse);
    const depth=engine.useReverseDepthBuffer?1:engine.isNDCHalfZRange?0:-1;
    Vector3.TransformCoordinatesFromFloatsToRef(-1,-1,depth,inverse,corner);
    Vector3.TransformCoordinatesFromFloatsToRef(1,-1,depth,inverse,right);
    Vector3.TransformCoordinatesFromFloatsToRef(-1,1,depth,inverse,up);
    Vector3.TransformCoordinatesFromFloatsToRef(1,1,depth,inverse,farCorner);

    vertices.length=0;
    if(Math.min(corner.y,right.y,up.y,farCorner.y)<water.level){
      const minX=Math.min(corner.x,right.x,up.x,farCorner.x),maxX=Math.max(corner.x,right.x,up.x,farCorner.x);
      const minZ=Math.min(corner.z,right.z,up.z,farCorner.z),maxZ=Math.max(corner.z,right.z,up.z,farCorner.z);
      for(const t of triangles){
        if(t.minX>maxX||t.maxX<minX||t.minZ>maxZ||t.maxZ<minZ)continue;
        vertices.push(t.ax-corner.x,t.az-corner.z,t.bx-corner.x,t.bz-corner.z,t.cx-corner.x,t.cz-corner.z);
      }
      // shortcut: fixed shader budget for the current close perspective near plane, revisit for wide orthographic views.
      if(vertices.length>maxTriangles*6)vertices.length=0;
    }

    if(vertices.length&&!post){
      post=new PostProcess('world/underwater',shaderName,{
        engine,size:1,samplingMode:Constants.TEXTURE_NEAREST_SAMPLINGMODE,
        uniforms:['nearRight','nearUp','cornerHeight','triangleCount','waterVertices'],
      });
      post.onApply=effect=>{
        effect.setVector3('nearRight',right);
        effect.setVector3('nearUp',up);
        effect.setFloat('cornerHeight',corner.y-water.level);
        effect.setInt('triangleCount',vertices.length/6);
        effect.setArray2('waterVertices',vertices);
      };
    }
    right.subtractInPlace(corner);
    up.subtractInPlace(corner);
    const next=vertices.length&&post?.isReady()?camera:undefined;
    if(next===attached)return;
    if(attached&&post)attached.detachPostProcess(post);
    attached=next;
    if(attached&&post)attached.attachPostProcess(post);
  });
  scope.onDispose(()=>{
    scene.onBeforeCameraRenderObservable.remove(observer);
    if(attached&&post)attached.detachPostProcess(post);
    post?.dispose();
  });
}
