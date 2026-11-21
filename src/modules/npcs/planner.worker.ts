import { createNpcAuthority, createNpcNavigation } from './headless.ts';
import { type PlannerData, type PlannerPlan, type PlannerQuery, type PlannerRequest, type PlannerResponse } from './planner-protocol.ts';

type Init = Extract<PlannerRequest,{type:'init'}>;
let init:Init|undefined;
let authority:ReturnType<typeof createNpcAuthority>|undefined;
const data:PlannerData[]=[];
let query:PlannerQuery|undefined;
let scheduled=false;
let reply=false;
let failed=false;
let initialOrigin:PlannerQuery['origin']|undefined;
const sent=new Map<string,object>();

const send=(response:PlannerResponse)=>self.postMessage(response);
function fail(cause:unknown) {
  failed=true;
  send({type:'error',error:cause instanceof Error?cause.message:String(cause)});
}

function prepare(start:Init) {
  const chunks=data.flatMap(packet=>packet.kind==='surface'?[{meshes:packet.meshes}]:[]);
  const roads=data.flatMap(packet=>packet.kind==='roads'?[...packet.roads]:[]);
  const crosswalks=data.flatMap(packet=>packet.kind==='crosswalks'?[...packet.crosswalks]:[]);
  const blockers=data.flatMap(packet=>packet.kind==='blockers'?[...packet.blockers]:[]);
  const doors=data.flatMap(packet=>packet.kind==='doors'?[...packet.doors]:[]);
  const interiors=data.flatMap(packet=>packet.kind==='interiors'?[...packet.interiors]:[]);
  data.length=0;
  const nav=createNpcNavigation({...start.map,chunks,roads,trafficLayout:{crosswalks}},
    {spawn:start.spawn,blockers,doors},interiors);
  return createNpcAuthority(nav,0);
}

function publish(current:NonNullable<typeof authority>,target:PlannerQuery) {
  const plans=new Map<string,PlannerPlan>();
  if (target.origin) {
    const {x,z}=target.origin;
    for (const plan of current.presentation(x,z)) {
      const id=plan.seed.id;
      plans.set(id,{kind:'resident',id,plan});
    }
    for (const plan of current.crowdPresentation(x,z)) {
      const id=plan.group.recipe.id;
      plans.set(id,{kind:'crowd',id,plan});
    }
  }
  const removed:string[]=[],added:PlannerPlan[]=[];
  for (const id of sent.keys()) if (!plans.has(id)) {
    removed.push(id);
    sent.delete(id);
  }
  let more=false;
  for (const [id,plan] of plans) {
    const revision=plan.kind==='resident'?plan.plan.seed:plan.plan.group;
    if (sent.get(id)===revision) continue;
    if (added.length>=3) {more=true;break;}
    sent.set(id,revision);
    added.push(plan);
  }
  send({type:'frame',tick:target.tick,population:current.population(),added,removed,more});
}

function pump() {
  scheduled=false;
  if (!query || !authority || failed) return;
  try {
    const limit=performance.now()+7;
    let busy=true;
    for (let work=0;work<8;work++) {
      busy=authority.planNext(query.tick,initialOrigin??null);
      if (!busy || performance.now()>=limit) break;
    }
    if (reply) {
      publish(authority,query);
      reply=false;
    }
    if (busy) queuePump();
  } catch (cause) { fail(cause); }
}
function queuePump() {
  if (scheduled) return;
  scheduled=true;
  setTimeout(pump,0);
}

self.onmessage=({data:message}:MessageEvent<PlannerRequest>)=>{
  if (failed) return;
  if (message.type==='init') {
    init=message;
  } else if (message.type==='data') {
    data.push(...message.batch);
  } else if (message.type==='prepare') {
    if (!init) return;
    try {
      authority=prepare(init);
      send({type:'ready'});
    } catch (cause) { fail(cause); }
  } else {
    query=message.query;
    initialOrigin??=query.origin??init?.spawn;
    reply=true;
    queuePump();
  }
};
