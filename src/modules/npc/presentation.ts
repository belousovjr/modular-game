type Point = {readonly x:number;readonly z:number};

export function interpolateNpcPosition(previous:Point,current:Point,progress:number){
  return {x:previous.x+(current.x-previous.x)*progress,z:previous.z+(current.z-previous.z)*progress};
}
