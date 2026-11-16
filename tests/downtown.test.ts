import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {citySource} from '../src/modules/world/city.ts';
import {generateCity} from '../src/modules/world-generation/headless.ts';
import {cityCollision} from '../src/modules/world/headless.ts';
import {createCharacterAuthorityFactory} from '../src/modules/characters/headless.ts';

test('real downtown has deterministic source IDs, riverbed, complex roads and mapped landmarks',()=>{
  const city=generateCity(citySource);
  const manifest=JSON.parse(readFileSync(new URL('../src/modules/world/data/downtown/city.json',import.meta.url),'utf8'));
  assert.equal(manifest.source.osmSha256,createHash('sha256').update(readFileSync(new URL('../src/modules/world/data/downtown/osm-snapshot.xml.gz',import.meta.url))).digest('hex'));
  assert.equal(city.id,'chicago-loop');assert.ok(city.roads.length>800);assert.ok(city.colliders.length>600);
  assert.equal(new Set(city.placements.map(p=>p.key)).size,city.placements.length);
  assert.ok(city.roads.some(r=>r.bridge));assert.ok(city.roads.some(r=>r.oneway==='yes'));
  assert.ok(city.roads.some(r=>r.points.some((p,i)=>i>0&&Math.abs(p[0]-r.points[i-1][0])>1&&Math.abs(p[1]-r.points[i-1][1])>1)));
  for(const name of ['willis','marina','wrigley','tribune','trump'])assert.ok(city.placements.some(p=>p.templateId===`city/${name}`));
  const surfaces=new Set(city.chunks.flatMap(c=>c.meshes.map(m=>m.surface)));
  for(const s of ['water','riverbed','bank','road','sidewalk','curb','marking'])assert.ok(surfaces.has(s));
  for(const chunk of city.chunks)for(const m of chunk.meshes)if(m.surface==='riverbed')for(let i=1;i<m.positions.length;i+=3)assert.ok(m.positions[i]<city.waterLevel);
  assert.throws(()=>generateCity({...city,chunks:[{...city.chunks[0],meshes:[{surface:'road',positions:[0,0,0,1,0,0,0,0,1],indices:[0,1,99]}]}]}),/triangles/);
});

test('downtown height triangles stay in authority after visual streaming, with 16 safe spawns sharing one index',()=>{
  const world=cityCollision(citySource),factory=createCharacterAuthorityFactory(world);
  const samples=[];
  for(let i=0;i<16;i++){
    const a=factory(0,{x:world.spawn.x+(i%4-1.5)*1.2,z:world.spawn.z+(Math.floor(i/4)-1.5)*1.1});
    const s=a.snapshot();assert.ok(s.y>-5&&s.y<20);samples.push(s.y);
    a.step(1);assert.ok(a.snapshot().grounded);
  }
  assert.ok(world.triangles&&world.triangles.length>10000);assert.equal(world.slopeX,0);
  assert.ok(Math.max(...samples)-Math.min(...samples)<.5);
});

test('street surfaces share raised boundaries and use terrain-sized triangles instead of warped spans',()=>{
  const road=new Map<string,number>(),curb=new Map<string,number>(),walk=new Map<string,number>();
  for(const chunk of citySource.chunks)for(const m of chunk.meshes){
    const map=m.surface==='road'?road:m.surface==='curb'?curb:m.surface==='sidewalk'?walk:null;
    if(!map)continue;
    for(let i=0;i<m.positions.length;i+=3){const key=`${m.positions[i]}/${m.positions[i+2]}`;map.set(key,Math.max(map.get(key)??-Infinity,m.positions[i+1]));}
    for(let i=0;i<m.indices.length;i+=3)for(let j=0;j<3;j++){
      const a=m.indices[i+j]*3,b=m.indices[i+(j+1)%3]*3;
      assert.ok(Math.hypot(m.positions[a]-m.positions[b],m.positions[a+2]-m.positions[b+2])<=Math.SQRT2*32+.001,'Long terrain bridge inside a street triangle');
    }
  }
  let roadMatches=0,walkMatches=0;
  for(const [key,y] of curb){
    const roadY=road.get(key),walkY=walk.get(key);
    if(roadY!==undefined){assert.ok(Math.abs(y-roadY-.25)<.001,'Broken curb height at road edge');roadMatches++;}
    if(walkY!==undefined){assert.ok(Math.abs(y-walkY)<.001,'Sidewalk does not meet curb');walkMatches++;}
  }
  assert.ok(roadMatches>1000&&walkMatches>1000);
});

test('facades contain fitted whole window cells, a plinth and a distinct roof without per-window geometry',()=>{
  let vertices=0;const styles=new Set<number>();
  for(const chunk of citySource.chunks)for(const m of chunk.meshes)if(m.surface==='city-stone'||m.surface==='city-glass'){
    assert.ok(m.uvs);assert.equal(m.uvs.length,m.positions.length/3*2);
    for(let i=0;i<m.uvs.length;i+=2){const u=m.uvs[i],v=m.uvs[i+1];assert.ok(Math.abs(u-Math.round(u))<.00001&&Math.abs(v-Math.round(v))<.00001,'Window row clipped by facade boundary');if(u<0)styles.add(u);vertices++;}
  }
  assert.ok(vertices>10000);for(const style of [-1,-2,-3])assert.ok(styles.has(style));
});


test('coarse city grid keeps object anchors, sizes and headings quantised',()=>{
  const onGrid=(v:number,step:number)=>Math.abs(v/step-Math.round(v/step))<1e-6;
  for(const p of citySource.placements){
    assert.ok(onGrid(p.position[0],1)&&onGrid(p.position[2],1),p.key);
    assert.ok(onGrid(p.rotation[1],Math.PI/12),p.key);
    for(const value of Object.values(p.parameters))assert.ok(onGrid(value,.25),p.key);
  }
  for(const r of citySource.roads){assert.ok(onGrid(r.width,.25));for(const p of r.points)assert.ok(onGrid(p[0],1)&&onGrid(p[1],1));}
});

test('reusable architectural parts use quarter-metre dimensions and 15 degree rotations',async()=>{
  const {cityTemplates,toCityGrid}=await import('../src/modules/world/city-templates.ts');
  const onGrid=(v:number,step:number)=>Math.abs(v/step-Math.round(v/step))<1e-6;
  for(const template of cityTemplates)for(const level of toCityGrid(template).build({width:32,depth:28,height:60,foundation:2,armLength:4}).levels)for(const part of level.parts){
    assert.ok(part.size.every(v=>v>=.25&&onGrid(v,.25)));
    assert.ok(!part.rotation||part.rotation.every(v=>onGrid(v,Math.PI/12)));
    assert.ok(!part.position||part.position.every(v=>onGrid(v,.125)));
  }
});


test('every lamp arm faces its own street after Babylon yaw and grid snapping',async()=>{
  const {Matrix,Vector3}=await import('@babylonjs/core/Maths/math.vector.js');
  const roads=new Map(citySource.roads.map(r=>[r.id,r]));let checked=0;
  for(const lamp of citySource.placements.filter(p=>p.templateId==='world/lamp')){
    const parts=lamp.key.split('/'),road=roads.get(parts.slice(2,-2).join('/'));assert.ok(road);
    let distance=Number(parts.at(-2)),x=0,z=0;
    for(let i=1;i<road.points.length;i++){
      const a=road.points[i-1],b=road.points[i],length=Math.hypot(b[0]-a[0],b[1]-a[1]);
      if(distance<=length||i===road.points.length-1){const t=length?Math.min(1,distance/length):0;x=a[0]+(b[0]-a[0])*t;z=a[1]+(b[1]-a[1])*t;break;}
      distance-=length;
    }
    const inward=new Vector3(x-lamp.position[0],0,z-lamp.position[2]).normalize();
    const arm=Vector3.TransformNormal(new Vector3(1,0,0),Matrix.RotationY(lamp.rotation[1]));
    assert.ok(Vector3.Dot(arm,inward)>.85,`Lamp points away from street: ${lamp.key}`);checked++;
  }
  assert.ok(checked>1000);
});


test('lamp light box does not overlap its metal arm before or after grid snapping',async()=>{
  const {worldTemplates}=await import('../src/modules/world/templates.ts');
  const {toCityGrid}=await import('../src/modules/world/city-templates.ts');
  const template=worldTemplates.find(t=>t.id==='world/lamp');assert.ok(template);
  for(const candidate of [template,toCityGrid(template)]){
    const parts=candidate.build({}).levels[0].parts;
    const head=parts.find(p=>p.surface==='lamp-head'),arm=parts.find(p=>p.surface==='metal'&&p.size[0]>1);
    assert.ok(head?.position&&arm?.position);
    const headPosition=head.position,armPosition=arm.position;
    const overlaps=head.size.map((size,i)=>Math.min(headPosition[i]+size/2,armPosition[i]+arm.size[i]/2)-Math.max(headPosition[i]-size/2,armPosition[i]-arm.size[i]/2));
    assert.ok(overlaps.some(v=>v<=1e-8),'Lamp box intersects its arm and shares visible coplanar faces');
    assert.ok(head.position[0]-head.size[0]/2>=arm.position[0]+arm.size[0]/2-1e-8);
  }
});

test('traffic layouts have complete separated crossings and curbside signals reaching over asphalt',()=>{
  const data=JSON.parse(readFileSync(new URL('../src/modules/world/data/downtown/city.json',import.meta.url),'utf8'));
  const {crosswalks,signals}=data.trafficLayout;
  assert.ok(crosswalks.length>100);assert.ok(signals.length>50);
  // Separating axes check uses the exported bands, independently of the offline polygon library.
  const overlaps=(a:number[][],b:number[][])=>[a,b].every(poly=>poly.every((p,i)=>{
    const q=poly[(i+1)%poly.length],nx=q[1]-p[1],nz=p[0]-q[0];
    const pa=a.map(v=>v[0]*nx+v[1]*nz),pb=b.map(v=>v[0]*nx+v[1]*nz);
    return Math.max(...pa)>Math.min(...pb)+.001&&Math.max(...pb)>Math.min(...pa)+.001;
  }));
  for(let i=0;i<crosswalks.length;i++){
    const c=crosswalks[i];assert.equal(c.depth,3);assert.ok(c.stripes.length>=4);
    for(let j=0;j<i;j++)assert.equal(overlaps(c.outline,crosswalks[j].outline),false,`Overlapping crossings ${c.id}`);
  }
  for(const s of signals){
    const p=citySource.placements.find(p=>p.key===s.id);assert.ok(p);
    assert.ok(s.curbClearance>=.75&&s.curbClearance<=1.75);
    const reach=p.parameters.armLength,yaw=p.rotation[1];
    assert.ok(Math.abs(p.position[0]-Math.cos(yaw)*reach-s.head[0])<.001);
    assert.ok(Math.abs(p.position[2]+Math.sin(yaw)*reach-s.head[1])<.001);
    assert.ok(-Math.sin(yaw)*s.facing[0]-Math.cos(yaw)*s.facing[1]>.99);
  }
});

test('street supports are embedded in the rendered sidewalk, including sloped pavement',()=>{
  let checked=0;
  for(const p of citySource.placements){
    if(p.templateId!=='world/lamp'&&p.templateId!=='city/signal')continue;
    const [x,y,z]=p.position;let pavement=-Infinity;
    for(const c of citySource.chunks){
      if(x<c.bounds.minX||x>c.bounds.maxX||z<c.bounds.minZ||z>c.bounds.maxZ)continue;
      for(const m of c.meshes)if(m.surface==='sidewalk')for(let i=0;i<m.indices.length;i+=3){
        const a=m.indices[i]*3,b=m.indices[i+1]*3,d=m.indices[i+2]*3,v=m.positions;
        const det=(v[b+2]-v[d+2])*(v[a]-v[d])+(v[d]-v[b])*(v[a+2]-v[d+2]);
        if(Math.abs(det)<1e-8)continue;
        const u=((v[b+2]-v[d+2])*(x-v[d])+(v[d]-v[b])*(z-v[d+2]))/det;
        const w=((v[d+2]-v[a+2])*(x-v[d])+(v[a]-v[d])*(z-v[d+2]))/det;
        if(u>=-1e-5&&w>=-1e-5&&u+w<=1.00001)pavement=Math.max(pavement,u*v[a+1]+w*v[b+1]+(1-u-w)*v[d+1]);
      }
    }
    assert.ok(Number.isFinite(pavement),`No sidewalk below ${p.key}`);
    assert.ok(y<pavement-.1&&y>pavement-.3,`Floating or buried support ${p.key}: ${y-pavement}`);checked++;
  }
  assert.ok(checked>1000);
});
