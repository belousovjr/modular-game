import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {citySource} from '../src/modules/world/city.ts';
import district from '../src/modules/world/data/downtown/district.json' with {type:'json'};
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
  for(const chunk of citySource.chunks)for(const m of [...chunk.meshes,...(chunk.details??[]).flatMap(d=>d.meshes)]){
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
  for(const chunk of citySource.chunks)for(const m of [...chunk.meshes,...(chunk.details??[]).flatMap(d=>d.meshes)])if(m.surface.startsWith('city-')){
    assert.ok(m.uvs);assert.equal(m.uvs.length,m.positions.length/3*2);
    for(let i=0;i<m.uvs.length;i+=2){const u=m.uvs[i],v=m.uvs[i+1];if(m.surface.endsWith('-detail'))assert.ok(Math.abs(u-Math.round(u))<.00001&&Math.abs(v-Math.round(v))<.00001,'Window row clipped by facade boundary');if(u<0)styles.add(u);vertices++;}
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

test('street supports are embedded in the rendered sidewalk, including sloped pavement',async()=>{
  const {worldTemplates}=await import('../src/modules/world/templates.ts');
  const {toCityGrid}=await import('../src/modules/world/city-templates.ts');
  const lamp=worldTemplates.find(t=>t.id==='world/lamp');assert.ok(lamp);
  const bases=[lamp,toCityGrid(lamp)].map(t=>t.build({}).levels[0].parts.find(p=>p.surface==='foundation'));
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
    assert.ok(y<pavement-.1&&y>pavement-.3,`Floating or buried support ${p.key}: ${y-pavement}`);
    if(p.templateId==='world/lamp')for(const base of bases){
      assert.ok(base?.position);
      const bottom=y+base.position[1]-base.size[1]/2,top=y+base.position[1]+base.size[1]/2;
      assert.ok(bottom<pavement,'Floating decorative foot');
      assert.ok(top-pavement>.17&&top-pavement<.26,'Decorative foot buried or too tall');
    }
    checked++;
  }
  assert.ok(checked>1000);
});

test('small river exclusions remain water and bed instead of extruded terrain pillars',()=>{
  const contains=(m:{positions:readonly number[];indices:readonly number[]},x:number,z:number)=>{
    const v=m.positions;
    for(let i=0;i<m.indices.length;i+=3){
      const a=m.indices[i]*3,b=m.indices[i+1]*3,c=m.indices[i+2]*3;
      const det=(v[b+2]-v[c+2])*(v[a]-v[c])+(v[c]-v[b])*(v[a+2]-v[c+2]);
      if(Math.abs(det)<1e-8)continue;
      const u=((v[b+2]-v[c+2])*(x-v[c])+(v[c]-v[b])*(z-v[c+2]))/det;
      const w=((v[c+2]-v[a+2])*(x-v[c])+(v[a]-v[c])*(z-v[c+2]))/det;
      if(u>=0&&w>=0&&u+w<=1)return true;
    }
    return false;
  };
  // Centres of pinned OSM inner ways 938561896/938561895/1267036922/1176285158.
  for(const [x,z] of [[-44.939,391.606],[-7.5,391.361],[-438.398,376.918],[-574.392,-1.098]]){
    const meshes=citySource.chunks.flatMap(c=>c.meshes);
    for(const surface of ['water','riverbed'])assert.ok(meshes.some(m=>m.surface===surface&&contains(m,x,z)),`Missing ${surface} at former pillar`);
    assert.equal(meshes.some(m=>(m.surface==='urban-ground'||m.surface==='terrain')&&contains(m,x,z)),false,'River exclusion became dry terrain');
  }
});

test('doors are omitted while batched roof plant remains',()=>{
  let roofs=0;
  for(const chunk of citySource.chunks)for(const m of [...chunk.meshes,...(chunk.details??[]).flatMap(d=>d.meshes)]){
    assert.notEqual(m.surface,'facade','Door panels must not be generated');
    if(m.surface==='foundation')for(let i=0;i<m.positions.length;i+=12)assert.ok(Math.abs(m.positions[i+4]-m.positions[i+1]-1.25)<.001,'Only roof plant walls, not door frames, may remain');
    if(m.surface==='roof')roofs+=m.indices.length/6;
  }
  assert.ok(roofs>300);
  const world=cityCollision(citySource);
  assert.ok(world.triangles);
  // Roof plant tops are visual detail, never a new authority walking plane.
  for(const c of citySource.chunks)for(const m of (c.details??[]).flatMap(d=>d.meshes))if(m.surface==='roof'){
    const x=m.positions[0],y=m.positions[1],z=m.positions[2];
    assert.equal(world.triangles.some(t=>t[0]===x&&t[1]===y&&t[2]===z),false);
  }
});

test('fixed Chicago review walk remains dry, unobstructed and uses metre-scale actors',()=>{
  const route=JSON.parse(readFileSync(new URL('../src/modules/world/data/downtown/review-route.json',import.meta.url),'utf8'));
  const world=cityCollision(citySource),factory=createCharacterAuthorityFactory(world);
  for(let segment=1;segment<route.walk.length;segment++){
    const a=route.walk[segment-1],b=route.walk[segment],length=Math.hypot(b[0]-a[0],b[1]-a[1]);
    for(let station=0;station<=length;station+=2){
      const t=station/length,x=a[0]+(b[0]-a[0])*t,z=a[1]+(b[1]-a[1])*t;
      for(const box of world.blockers)assert.ok(x<box.minX-.35||x>box.maxX+.35||z<box.minZ-.35||z>box.maxZ+.35,`Blocked review walk at ${x},${z}`);
      const actor=factory(0,{x,z});actor.step(1);const snapshot=actor.snapshot();
      assert.ok(snapshot.grounded&&snapshot.y>citySource.waterLevel+1);
    }
  }
});

test('Marina balcony slabs use textured concrete without facade windows',async()=>{
  const {cityTemplates,toCityGrid}=await import('../src/modules/world/city-templates.ts');
  const template=cityTemplates.find(t=>t.id==='city/marina');assert.ok(template);
  for(const candidate of [template,toCityGrid(template)]){
    const model=candidate.build({width:32,depth:32,height:179,foundation:2});
    const slabs=model.levels[0].parts.filter(p=>p.size[1]<=.25);
    assert.ok(slabs.length>40);
    assert.ok(slabs.every(p=>p.surface==='foundation'));
    assert.ok(model.levels[1].parts.every(p=>p.size[1]>.25));
    assert.ok(model.levels[2].parts.length<model.levels[1].parts.length);
    assert.ok(model.levels[1].parts.some(p=>p.surface==='city-stone'));
  }
});


test('roof plant caps face upward and walls face outward with textured concrete',async()=>{
  const {VertexData}=await import('@babylonjs/core/Meshes/mesh.vertexData.js');
  let count=0;
  for(const chunk of citySource.chunks.flatMap(c=>[c,...c.details??[]])){
    const caps=chunk.meshes.find(m=>m.surface==='roof');
    if(!caps)continue;
    const normals:number[]=[];VertexData.ComputeNormals([...caps.positions],[...caps.indices],normals);
    assert.ok(normals.filter((_,i)=>i%3===1).every(y=>y>.99),'Roof cap is back-facing from above');
    const walls=chunk.meshes.find(m=>m.surface==='foundation');assert.ok(walls);
    const wallNormals:number[]=[];VertexData.ComputeNormals([...walls.positions],[...walls.indices],wallNormals);
    for(let i=0;i<walls.positions.length;i+=12){
      const v=walls.positions,x=(v[i]+v[i+9])/2,z=(v[i+2]+v[i+11])/2,top=v[i+4];
      let outward=false;
      for(let j=0;j<caps.positions.length;j+=12){
        const roof=caps.positions,cx=(roof[j]+roof[j+6])/2,cz=(roof[j+2]+roof[j+8])/2;
        if(Math.abs(top-roof[j+1])<.001&&Math.abs(x-cx)<=1.751&&Math.abs(z-cz)<=1.251){
          outward=wallNormals[i]*(x-cx)+wallNormals[i+2]*(z-cz)>0;break;
        }
      }
      assert.ok(outward,'Roof plant wall has inward normal');count++;
    }
  }
  assert.ok(count>1000);
});


test('ordinary skyline omits all trim and near detail is separately bounded and validated',()=>{
  const details=citySource.chunks.flatMap(c=>c.details??[]);
  assert.ok(details.length>600);
  const far=citySource.chunks.flatMap(c=>c.meshes).filter(m=>m.surface.startsWith('city-'));
  const near=details.flatMap(d=>d.meshes).filter(m=>m.surface.endsWith('-detail'));
  const triangles=(meshes:typeof far)=>meshes.reduce((n,m)=>n+m.indices.length/3,0);
  assert.ok(triangles(far)<triangles(near)*.15,'Distant buildings must be much simpler');
  for(const m of far)assert.ok(m.uvs?.filter((_,i)=>i%2===0).every(u=>u>=0||u===-2),'Distant skyline contains trim/plinth roles');
  const base=citySource.chunks.find(c=>c.details?.length);assert.ok(base?.details);
  const detail=base.details[0];
  const excess=[1024,1024,1].map((count,i)=>({id:`excess/${i}`,bounds:citySource.bounds,buildingIds:[],meshes:[],details:Array.from({length:count},(_,j)=>({id:`excess/${i}/${j}`,bounds:citySource.bounds,meshes:[]}))}));
  assert.throws(()=>generateCity({...citySource,chunks:excess}),/details/);
  assert.throws(()=>generateCity({...citySource,chunks:[{...base,details:[{...detail,meshes:[{surface:'city-stone-detail',positions:[0,0,0],indices:[0,1,2]}]}]}]}),/triangles/);
});

test('every landmark sheds detail early and strongly reduces its distant silhouette',async()=>{
  const {cityTemplates,toCityGrid}=await import('../src/modules/world/city-templates.ts');
  for(const name of ['marina','willis','trump','wrigley','tribune']){
    const template=cityTemplates.find(t=>t.id==='city/'+name);assert.ok(template);
    const model=toCityGrid(template).build({width:32,depth:32,height:179,foundation:2});
    assert.equal(model.levels[1].distance,24);assert.equal(model.levels[2].distance,80);
    assert.ok(model.levels[2].parts.length<model.levels[1].parts.length);
    assert.ok(model.levels[2].parts.length<=6);
  }
});


test('coarse building batches are split by height with much shorter small-building ranges',()=>{
  const bands=district.buildingLod;
  assert.ok(bands[0].unload<bands[1].load&&bands[1].unload<bands[2].load);
  assert.equal(bands[2].load,1200);assert.equal(bands[2].unload,1400);
  assert.ok(bands[0].unload<=220&&bands[1].unload<=480);
  const surfaces=citySource.chunks.flatMap(c=>c.meshes).filter(m=>m.surface.startsWith('city-'));
  for(const band of bands)assert.ok(surfaces.some(m=>m.surface.endsWith('-'+band.id)));
  assert.ok(surfaces.every(m=>bands.some(b=>m.surface.endsWith('-'+b.id))));
});


test('coarse and detailed facades share window pitch and phase on matching walls',()=>{
  let checked=0;
  for(const chunk of citySource.chunks){
    const refs=[];
    for(const m of (chunk.details??[]).flatMap(d=>d.meshes).filter(m=>m.surface.endsWith('-detail'))){
      assert.ok(m.uvs);
      for(let i=0;i<m.indices.length;i+=3){
        const [a,b,c]=m.indices.slice(i,i+3),p=m.positions,uv=m.uvs;
        if(uv[a*2]<0||uv[b*2]<0||uv[c*2]<0||p[a*3+1]>=p[b*3+1]||Math.abs(p[b*3+1]-p[c*3+1])>.001)continue;
        const ax=p[a*3],az=p[a*3+2],dx=p[c*3]-ax,dz=p[c*3+2]-az,length=Math.hypot(dx,dz);
        refs.push({ax,az,tx:dx/length,tz:dz/length,length,u0:uv[a*2],du:uv[c*2]-uv[a*2],y0:p[a*3+1],v0:uv[a*2+1],vScale:(uv[b*2+1]-uv[a*2+1])/(p[b*3+1]-p[a*3+1])});
      }
    }
    for(const m of chunk.meshes.filter(m=>m.surface.startsWith('city-'))){
      assert.ok(m.uvs);
      for(let i=0;i<m.indices.length;i+=3){
        const [a,b,c]=m.indices.slice(i,i+3),p=m.positions,uv=m.uvs;
        if(uv[a*2]<0||uv[b*2]<0||uv[c*2]<0||p[a*3+1]>=p[b*3+1]||Math.abs(p[b*3+1]-p[c*3+1])>.001)continue;
        const x=(p[a*3]+p[c*3])/2,z=(p[a*3+2]+p[c*3+2])/2,dx=p[c*3]-p[a*3],dz=p[c*3+2]-p[a*3+2],length=Math.hypot(dx,dz);
        const adjacent=refs.filter(r=>{
          const along=(x-r.ax)*r.tx+(z-r.az)*r.tz;
          return along>r.length*.1&&along<r.length*.9&&Math.abs((x-r.ax)*r.tz-(z-r.az)*r.tx)<.1&&(r.tx*dx+r.tz*dz)/length>.999;
        });
        if(!adjacent.length)continue;
        assert.ok(adjacent.some(r=>{
          const along=(x-r.ax)*r.tx+(z-r.az)*r.tz;
          const delta=(uv[a*2]+uv[c*2])/2-(r.u0+along*r.du/r.length);
          const scale=(uv[c*2]-uv[a*2])/length;
          const vScale=(uv[b*2+1]-uv[a*2+1])/(p[b*3+1]-p[a*3+1]);
          const vAtReference=uv[a*2+1]+(r.y0-p[a*3+1])*vScale;
          return Math.abs(delta-Math.round(delta))<.003&&Math.abs(scale-r.du/r.length)<.003&&Math.abs(vAtReference-r.v0)<.003&&Math.abs(vScale-r.vScale)<.003;
        }),'Window grid jumps between matching LOD walls');checked++;
      }
    }
  }
  assert.ok(checked>500);
});
