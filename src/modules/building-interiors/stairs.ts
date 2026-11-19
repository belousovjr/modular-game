import type { BuildingProfile } from '../world/index.ts';
import { openingCorners, type Opening } from './floor-openings.ts';

type Vertex = readonly [across:number,height:number,inward:number];

export function buildStairs(profile:BuildingProfile, openings:readonly Opening[], low:number, high:number) {
  const steps={positions:[] as number[],indices:[] as number[]};
  const rails={positions:[] as number[],indices:[] as number[],uvs:[] as number[]};
  const [ox,,oz]=profile.origin;
  const cos=Math.cos(profile.yaw), sin=Math.sin(profile.yaw);
  for (const opening of openings) {
    const front=opening.stairFront;
    if (front===undefined || high<=low) continue;
    const corners=openingCorners(opening), a=corners[front], b=corners[(front+1)%4];
    const width=Math.hypot(b[0]-a[0],b[1]-a[1]);
    const length=front%2===0 ? opening.maxZ-opening.minZ : opening.maxX-opening.minX;
    const tx=(b[0]-a[0])/width, tz=(b[1]-a[1])/width;
    function face(target:typeof steps | typeof rails, points:readonly Vertex[]) {
      const first=target.positions.length/3;
      for (const [u,y,d] of points) {
        const x=a[0]+tx*u-tz*d, z=a[1]+tz*u+tx*d;
        target.positions.push(ox+x*cos+z*sin,y,oz-x*sin+z*cos);
      }
      target.indices.push(first,first+1,first+2,first,first+2,first+3);
      if ('uvs' in target) {
        const [p,q,r]=points;
        const w=Math.hypot(q[0]-p[0],q[1]-p[1],q[2]-p[2])/2;
        const h=Math.hypot(r[0]-q[0],r[1]-q[1],r[2]-q[2])/2;
        target.uvs.push(0,0,w,0,w,h,0,h);
      }
    }
    // Each prism can slope along the run; concrete treads use equal heights at both ends.
    function prism(target:typeof steps | typeof rails, x0:number,x1:number,z0:number,z1:number,
      low0:number,high0:number,low1=low0,high1=high0) {
      const a:Vertex=[x0,low0,z0], b:Vertex=[x1,low0,z0], c:Vertex=[x1,low1,z1], d:Vertex=[x0,low1,z1];
      const e:Vertex=[x0,high0,z0], f:Vertex=[x1,high0,z0], g:Vertex=[x1,high1,z1], h:Vertex=[x0,high1,z1];
      face(target,[a,b,f,e]); face(target,[b,c,g,f]); face(target,[c,d,h,g]); face(target,[d,a,e,h]);
      face(target,[e,f,g,h]); face(target,[d,c,b,a]);
    }
    const middle=(low+high)/2, rise=(high-low)/2;
    const count=Math.ceil(rise/.20), stepHeight=rise/count;
    const landing=Math.min(.9,length*.34), run=length-landing, tread=run/count;
    const wallDepth=.10;
    const gap=.06, left=width/2-gap/2, right=width/2+gap/2;
    prism(steps,0,wallDepth,0,length,low,high);
    prism(steps,width-wallDepth,width,0,length,low,high);
    for (let i=0;i<count;i++) {
      const y=low+(i+1)*stepHeight, z=i*tread;
      prism(steps,wallDepth,left,z,z+tread,y-.14,y);
      const upper=high-i*stepHeight;
      prism(steps,right,width-wallDepth,z,z+tread,upper-.14,upper);
    }
    const supportHalf=Math.min(.11,(left-wallDepth)/4);
    const leftCenter=(left+wallDepth)/2, rightCenter=(right+width-wallDepth)/2;
    prism(steps,leftCenter-supportHalf,leftCenter+supportHalf,0,run,low-.22,low-.04,middle-.22,middle-.04);
    prism(steps,rightCenter-supportHalf,rightCenter+supportHalf,0,run,high-.22,high-.04,middle-.22,middle-.04);
    prism(steps,wallDepth,width-wallDepth,run,length,middle-.16,middle);
    for (const [x,firstY,lastY] of [[left-.025,low,middle],[right+.025,high,middle]]) {
      for (const fraction of [.04,.5,.96]) {
        const z=run*fraction, y=firstY+(lastY-firstY)*fraction;
        prism(rails,x-.016,x+.016,z-.016,z+.016,y-.1,y+.87);
      }
      prism(rails,x-.026,x+.026,run*.04,run*.96,
        firstY+(lastY-firstY)*.04+.85,firstY+(lastY-firstY)*.04+.90,
        firstY+(lastY-firstY)*.96+.85,firstY+(lastY-firstY)*.96+.90);
    }
    const end=length-.045;
    for (const x of [wallDepth+.05,width-wallDepth-.05]) prism(rails,x-.016,x+.016,end-.016,end+.016,middle-.05,middle+.87);
    prism(rails,wallDepth+.034,width-wallDepth-.034,end-.024,end+.024,middle+.85,middle+.90);
  }
  return {steps,rails};
}
