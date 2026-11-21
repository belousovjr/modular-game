import assert from 'node:assert/strict';
import { test } from 'node:test';
import { streetSelection } from '../src/modules/npcs/spacing.ts';
import { createLocalAuthority, STEP_MS } from '../src/simulation/authority.ts';
import { createNpcAuthority, createNpcNavigation, deriveNpcCycle, npcPose, trafficConflict, createStreetSchedule, sampleNpc, spreadWalkLeg, crowdTiming, crowdTrack, crowdCycles, type NpcCrowd, type NpcSeed } from '../src/modules/npcs/headless.ts';
import { citySource } from '../src/modules/world/city.ts';
import { getBuildingInteriorSources } from '../src/modules/world/building-profiles.ts';
import { cityCollision } from '../src/modules/world/headless.ts';

let navigation: ReturnType<typeof createNpcNavigation> | undefined;
function city() {
  return navigation??=createNpcNavigation(citySource,cityCollision(citySource),getBuildingInteriorSources(citySource));
}

test('city recipes vary by seed, generate jobs from the map and reproduce arbitrary ticks from JSON',()=>{
  const nav=city(), visit=nav.visits.find(v=>v.paths.length>=2 && Math.hypot(v.node.point[0]-nav.spawn.x,v.node.point[2]-nav.spawn.z)<155);
  assert.ok(visit);
  const seed: NpcSeed={id:'npc/test',seed:15,startTick:120,personality:2,anchor:visit.node.id,home:visit.node.id,navigation:nav.version};
  const cycles=Array.from({length:28},(_,i)=>deriveNpcCycle(nav,{...seed,seed:i+1})!);
  assert.ok(new Set(cycles.map(c=>c.endAnchor)).size>=4);
  assert.ok(new Set(cycles.map(c=>c.endTick)).size>=12);
  const withVisit=cycles.find(c=>c.legs.some(l=>l.door)&&c.legs.some(l=>l.b[1]-l.a[1]>1)&&c.legs.some(l=>l.a[1]-l.b[1]>1));
  assert.ok(withVisit);
  const crossing=withVisit.legs.find(l=>l.door)!;
  assert.equal(npcPose(withVisit,crossing.from)?.doorOpen,1);
  const c=deriveNpcCycle(nav,seed)!;
  const decoded: NpcSeed=JSON.parse(JSON.stringify(seed));
  const tick=Math.floor((c.endTick+seed.startTick)/2);
  assert.deepEqual(npcPose(deriveNpcCycle(nav,decoded)!,tick),npcPose(c,tick));
  assert.equal(deriveNpcCycle(nav,{...seed,navigation:'old-map'}),undefined);
  assert.equal(deriveNpcCycle(nav,{...seed,anchor:'p//-44'}),undefined);
  assert.equal(deriveNpcCycle(nav,{...seed,seed:NaN}),undefined);
  const runners=Array.from({length:10},(_,i)=>deriveNpcCycle(nav,{...seed,personality:1,seed:i+1})!);
  assert.ok(runners.some(cycle=>cycle.legs.some(l=>l.mode==='run')));
  const roads=nav.roadNodes.filter(n=>nav.parking(n)&&Math.hypot(n.point[0]-nav.spawn.x,n.point[2]-nav.spawn.z)<220);
  assert.ok(roads.some(n=>{
    const c=deriveNpcCycle(nav,{...seed,personality:3,anchor:n.id,home:n.id})!;
    const motion=c.legs.find(leg=>leg.mode==='drive' && leg.distance>80);
    if (!motion) return false;
    const pose=npcPose(c,motion.from)!;
    assert.ok(pose.speed>0 && Number.isFinite(pose.steering) && pose.distance>80);
    assert.deepEqual(c.legs[0].a,nav.parking(n)!.point);
    assert.deepEqual(c.legs.at(-1)!.b,nav.parking(nav.node(c.endAnchor)!)!.point);
    assert.ok(c.legs.every(leg=>leg.length>0));
    const start=npcPose(c,c.legs[0].from)!;
    const end=npcPose(c,c.endTick)!;
    const angle=(a:number,b:number)=>Math.abs(Math.atan2(Math.sin(a-b),Math.cos(a-b)));
    assert.ok(angle(start.yaw,nav.parking(n)!.yaw)<1e-8);
    assert.ok(angle(end.yaw,nav.parking(nav.node(c.endAnchor)!)!.yaw)<1e-8);
    assert.ok(npcPose(c,c.legs[0].until)!.wheelDistance<0);
    assert.ok(Math.hypot(end.point[0]-start.point[0],end.point[2]-start.point[2])>175);
    for (const l of c.legs) for (const tick of [l.from,l.until-1])
      assert.ok(angle(npcPose(c,tick)!.yaw,npcPose(c,tick+1)!.yaw)<=.02500001);
    return true;
  }));
});

test('authority streams compact recipes, avoids reservations and keeps positions continuous across rollovers',()=>{
  const nav=city(), authority=createNpcAuthority(nav,0,26);
  let changed=false;
  const previous=new Map<string,NpcSeed>();
  const x=nav.spawn.x,z=nav.spawn.z;
  const observed=new Set<string>();
  const cycles=new Map<NpcSeed,NonNullable<ReturnType<typeof deriveNpcCycle>>>();
  for (let tick=1;tick<=18000;tick++) {
    authority.step(tick);
    if (tick%30) continue;
    const nearby=authority.snapshot(x,z);
    assert.equal(nearby.tick,tick);
    const sampled=new Set(nearby.scenarios);
    for (const dx of [-1500,-1125,-750,-375,0,375,750,1125,1500]) for (const dz of [-1500,-1125,-750,-375,0,375,750,1125,1500])
      for (const seed of authority.snapshot(x+dx,z+dz).scenarios) sampled.add(seed);
    const reserved=new Map<string,{from:number;until:number}[]>();
    for (const s of sampled) {
      observed.add(s.id);
      assert.deepEqual(Object.keys(s).filter(k=>k!=='wait').sort(),['anchor','home','id','navigation','personality','seed','startTick']);
      let cycle=cycles.get(s);
      if (!cycle) { cycle=deriveNpcCycle(nav,s)!; cycles.set(s,cycle); }
      for (const r of cycle.reservations) {
        const overlapping=(reserved.get(r.id)??[]).some(other=>other.from<r.until && r.from<other.until);
        if (r.until>tick) {
          assert.ok(!overlapping,r.id);
          reserved.set(r.id,[...(reserved.get(r.id)??[]),r]);
        }
      }
      const prev=previous.get(s.id);
      if (prev && prev!==s && s.startTick===cycles.get(prev)?.endTick) {
        const last=cycles.get(prev)!;
        assert.deepEqual(npcPose(last,s.startTick)?.point,npcPose(cycle,s.startTick)?.point);
        changed=true;
      }
      previous.set(s.id,s);
    }
  }
  assert.ok(changed && observed.size>=8);
  assert.ok(authority.population()>=22);
  assert.deepEqual(authority.snapshot(nav.bounds.maxX+800,z).scenarios,[]);
  assert.deepEqual(authority.snapshot(NaN,z).scenarios,[]);
});

test('fixed ticks converge after different frame pacing and retained browser debt',()=>{
  const nav=city(), x=nav.spawn.x,z=nav.spawn.z;
  function run(deltas: readonly number[]) {
    const clock=createLocalAuthority(), population=createNpcAuthority(nav,0,8);
    clock.addSystem(population.step);
    for (const delta of deltas) clock.advance(delta);
    while (clock.snapshot().pendingTicks) clock.advance(0);
    const nearby=new Set<NpcSeed>();
    for (const dx of [-1500,-1125,-750,-375,0,375,750,1125,1500]) for (const dz of [-1500,-1125,-750,-375,0,375,750,1125,1500])
      for (const seed of population.snapshot(x+dx,z+dz).scenarios) nearby.add(seed);
    return {tick:clock.snapshot().tick,scenarios:[...nearby]};
  }
  const baseline=run(Array<number>(450).fill(STEP_MS*2));
  assert.equal(baseline.tick,900);
  assert.ok(baseline.scenarios.length);
  assert.deepEqual(run(Array<number>(2160).fill(STEP_MS*60/144)),baseline);
  assert.deepEqual(run([STEP_MS*900]),baseline);
});

test('13,900 residents share compact routes across the district with more drivers',t=>{
  const nav=city(), authority=createNpcAuthority(nav,0);
  let now=0;
  while (now<7300 && (now<3600 || authority.population()<13900)) authority.step(++now);
  assert.equal(authority.population(),13900);
  const residents=new Map<string,NpcSeed>();
  const crowds=new Map<string,NpcCrowd>();
  const circuits=new Map<string,number>();
  const visitedPavement=new Set<string>();
  const cars=new Map<string,ReturnType<typeof deriveNpcCycle>>();
  const {minX,minZ,maxX,maxZ}=nav.bounds;
  for (let x=minX+60;x<maxX+60;x+=120) for (let z=minZ+60;z<maxZ+60;z+=120) {
    const snapshot=authority.snapshot(x,z), local=snapshot.scenarios;
    assert.ok(local.length+snapshot.crowds.length<130);
    const localCrowds=authority.crowdPresentation(x,z);
    assert.deepEqual(localCrowds.map(entry=>entry.group),snapshot.crowds);
    for (const {group,outdoors} of localCrowds) {
      if (circuits.has(group.recipe.id)) continue;
      const starts=new Set(outdoors.map(plan=>plan.endAnchor));
      assert.equal(starts.size,outdoors.length);
      for (const plan of outdoors.slice(1)) {
        const stops=new Set(plan.legs.filter(leg=>leg.mode==='idle').map(leg=>leg.a.join('/')));
        assert.ok(stops.size>=3);
      }
      circuits.set(group.recipe.id,starts.size);
      for (const track of outdoors) for (const leg of track.legs) {
        const n=Math.max(1,Math.ceil(leg.length/12));
        for (let i=0;i<=n;i++) {
          const t=i/n;
          visitedPavement.add(`${Math.floor((leg.a[0]+t*(leg.b[0]-leg.a[0]))/36)}/${Math.floor((leg.a[2]+t*(leg.b[2]-leg.a[2]))/36)}`);
        }
      }
    }
    for (const group of snapshot.crowds) crowds.set(group.recipe.id,group);
    const presentation=authority.presentation(x,z);
    assert.deepEqual(presentation.map(entry=>entry.seed),local);
    for (const entry of presentation) if (entry.seed.home.startsWith('r/')) cars.set(entry.seed.id,entry.cycle);
    for (const seed of local) residents.set(seed.id,seed);
  }
  assert.equal(residents.size,1200);
  assert.equal([...crowds.values()].reduce((count,group)=>count+group.count,0),12700);
  assert.ok(crowds.size>=908);
  const anchorCells=new Set([...crowds.values()].map(({recipe})=>{
    const [x,,z]=nav.node(recipe.anchor)!.point;
    return `${Math.floor(x/36)}/${Math.floor(z/36)}`;
  }));
  assert.equal(anchorCells.size,crowds.size);
  const covered=nav.walkSites.filter(site=>visitedPavement.has(site.key)).length;
  assert.ok(covered>=nav.walkSites.length*.55,`${covered}/${nav.walkSites.length} paved cells visited`);
  const varied=[...circuits.values()].filter(count=>count>=3).length;
  assert.ok(varied>=circuits.size*.65,`${varied}/${circuits.size} groups have at least three different routes`);
  const group=[...crowds.values()].find(g=>g.count>=2)!;
  const fromJson: NpcCrowd=JSON.parse(JSON.stringify(group));
  const {full:cycle,outdoors}=crowdCycles(nav,group)!;
  const {full:reproduced}=crowdCycles(nav,fromJson)!;
  assert.equal(group.slots.length,group.count);
  const track=crowdTrack(cycle,outdoors,group,0);
  const anchor=crowdTrack(reproduced,crowdCycles(nav,fromJson)!.outdoors,fromJson,0);
  const time=crowdTiming(track,group,0),recreated=crowdTiming(anchor,fromJson,0);
  assert.deepEqual(time,recreated);
  assert.deepEqual(sampleNpc(track,123456,time.phase,time.pace),
    sampleNpc(anchor,123456,recreated.phase,recreated.pace));
  assert.ok(cycle.legs.at(-1)!.distance>=55);
  assert.ok(outdoors.every(track=>track.legs.every(leg=>leg.door===undefined)));
  for (const plan of [cycle,...outdoors]) {
    assert.deepEqual(plan.legs[0].a,plan.legs.at(-1)!.b);
    for (let i=1;i<plan.legs.length;i++) {
      assert.deepEqual(plan.legs[i-1].b,plan.legs[i].a);
      assert.equal(plan.legs[i-1].until,plan.legs[i].from);
    }
  }
  assert.deepEqual(authority.snapshot(maxX+800,maxZ+800).crowds,[]);
  assert.equal(new Set([...residents.values()].map(seed=>seed.home)).size,1200);
  const quadrants=[0,0,0,0];
  let core=0,drivers=0;
  for (const seed of residents.values()) {
    const {point:[x,,z]}=nav.node(seed.home)!;
    const dx=x-nav.spawn.x,dz=z-nav.spawn.z;
    quadrants[Number(dx>=0)+2*Number(dz>=0)]++;
    if (Math.abs(dx)<565 && Math.abs(dz)<565) core++;
    if (seed.home.startsWith('r/')) drivers++;
  }
  assert.ok(quadrants.every(count=>count>=108 && count<=505),quadrants.join(', '));
  assert.ok(core>=113 && core<=278,String(core));
  t.diagnostic(`${residents.size+12700-drivers} pedestrians, ${drivers} drivers`);
  assert.ok(drivers>=620 && drivers<=800,String(drivers));
  const driving=[...cars.values()].filter(cycle=>cycle!==undefined);
  const traveling=driving.filter(cycle=>cycle.legs.at(-1)!.distance>20).length;
  t.diagnostic(`${traveling} cars on a traveling cycle`);
  assert.ok(traveling>=300,`${traveling}/${drivers} on a traveling cycle`);
  for (let tick=now;tick<=now+6000;tick+=60) {
    const active=driving.filter(c=>c.legs[0].from<=tick&&tick<c.endTick).map(c=>npcPose(c,tick)!);
    for (let i=0;i<active.length;i++) for (let j=i+1;j<active.length;j++) {
      const a=active[i],b=active[j];
      if (Math.abs(a.point[0]-b.point[0])>5.9||Math.abs(a.point[2]-b.point[2])>5.9) continue;
      assert.equal(trafficConflict({a:a.point,b:a.point,yaw:a.yaw,from:tick,until:tick+1},
        {a:b.point,b:b.point,yaw:b.yaw,from:tick,until:tick+1}),false);
    }
  }
});


test('swept traffic detects crossings, stationary cars and separated bridge levels',()=>{
  const east={a:[-12,0,0],b:[12,0,0],from:0,until:120} as const;
  const north={a:[0,0,-12],b:[0,0,12],from:0,until:120} as const;
  assert.equal(trafficConflict(east,north),true);
  assert.equal(trafficConflict(east,{a:[12,0,2.9],b:[-12,0,2.9],from:0,until:120}),false);
  assert.equal(trafficConflict(east,{...north,from:90,until:210}),false);
  assert.equal(trafficConflict(east,{...north,a:[0,5,-12],b:[0,5,12]}),false);
  assert.equal(trafficConflict(east,{a:[0,0,0],b:[0,0,0],from:30,until:Infinity}),true);
});


test('pedestrians take a marked crossing on a reachable detour',()=>{
  const bounds={minX:-12,maxX:12,minZ:-20,maxZ:20};
  const rect=(surface:string,minX:number,maxX:number)=>({surface,positions:[minX,0,-20,maxX,0,-20,maxX,0,20,minX,0,20],indices:[0,1,2,0,2,3]});
  const data={version:1,id:'crossing',bounds,spawn:{x:-8,z:0},waterLevel:-4,roads:[],colliders:[],placements:[],
    chunks:[{id:'block',bounds,buildingIds:[],meshes:[rect('sidewalk',-12,-4),rect('road',-4,4),rect('sidewalk',4,12)]}],
    trafficLayout:{crosswalks:[{center:[0,8],direction:[0,1],outline:[[-4,6.5],[4,6.5],[4,9.5],[-4,9.5]]}]}};
  const nav=createNpcNavigation(data,{spawn:data.spawn,blockers:[]},[]);
  const profile={travel:'walk',north:0,running:0,indoors:0,shortcuts:0} as const;
  const route=nav.route(nav.findFoot(-8,0)!,nav.findFoot(8,0)!,profile,42)!;
  assert.ok(route.filter(n=>Math.abs(n.point[0])<4).every(n=>n.point[2]===8));
});

test('seeded pedestrians can diverge across a plaza and stay inside a narrow pavement',()=>{
  function pavement(depth:number) {
    const bounds={minX:0,maxX:30,minZ:-depth,maxZ:depth},spawn={x:0,z:0};
    const mesh={surface:'sidewalk',positions:[0,0,-depth,30,0,-depth,30,0,depth,0,0,depth],indices:[0,1,2,0,2,3]};
    return createNpcNavigation({version:1,id:'test',bounds,roads:[],
      chunks:[{meshes:[mesh]}]},{spawn,blockers:[]},[]);
  }
  const plaza=pavement(14),a=[2,0,0] as const,b=[28,0,0] as const;
  const first=spreadWalkLeg(plaza,a,b,-1,.35,12),second=spreadWalkLeg(plaza,a,b,1,.65,9);
  assert.ok(first&&second&&Math.abs(first[2]-second[2])>18);
  assert.notEqual(first[0],second[0]);
  assert.equal(spreadWalkLeg(pavement(1.5),a,b,-1,.4,12),undefined);
});


test('visible slots spread across nearby street cells and preserve existing models',()=>{
  const crowded=Array.from({length:22},(_,i)=>({car:false,cell:'square',existing:i===0,onScreen:true,d:i}));
  const spread=Array.from({length:10},(_,i)=>({car:false,cell:`street/${i}`,existing:false,onScreen:true,d:40+i}));
  const result=streetSelection([...crowded,...spread]);
  assert.equal(result.length,14);
  assert.equal(result.filter(candidate=>candidate.cell==='square').length,4);
  assert.ok(result.includes(crowded[0]));
  assert.ok(spread.every(candidate=>result.includes(candidate)));
});


function straight(a:readonly [number,number,number],b:readonly [number,number,number],mode:'drive'|'walk',start=0,duration=120) {
  const yaw=Math.atan2(b[0]-a[0],b[2]-a[2]),length=Math.hypot(b[0]-a[0],b[2]-a[2]);
  return {endTick:start+duration,endAnchor:'fixture',heading:yaw,reservations:[],
    legs:[{a,b,from:start,until:start+duration,length,distance:0,mode,yaw,pitch:0,into:0,out:0}]};
}

test('the planner assigns different departure slots when two repeating walks cross',()=>{
  const schedule=createStreetSchedule({minX:-50,maxX:50,minZ:-50,maxZ:50});
  const east=straight([-12,0,0],[12,0,0],'walk',0,3600);
  const north=straight([0,0,-12],[0,0,12],'walk',0,3600);
  const a=schedule.template(east),b=schedule.template(north);
  assert.equal(schedule.book(a,0),0);
  assert.equal(schedule.conflicts(b,0),true);
  const booked=schedule.book(b,0);
  assert.notEqual(booked,undefined);
  assert.notEqual(booked,0);
  assert.equal(schedule.conflicts(b,booked!),true);
});

test('a planned road trip cannot reserve the crossing occupied by a pedestrian',()=>{
  const schedule=createStreetSchedule({minX:-50,maxX:50,minZ:-50,maxZ:50});
  const person=straight([0,0,-10],[0,0,10],'walk',0,480);
  const car=straight([-14,0,0],[14,0,0],'drive',0,480);
  const walking=schedule.detailed(person,false),driving=schedule.detailed(car,true);
  schedule.change(walking,false,1);
  assert.equal(schedule.conflictsDetailed(driving,true),true);
  assert.equal(schedule.conflictsDetailed(driving,true,21),false);
  schedule.change(walking,false,-1);
  assert.equal(schedule.conflictsDetailed(driving,true),false);
});
