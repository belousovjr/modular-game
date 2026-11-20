import {buildInterior} from './shell.ts';
import {partitionInterior} from './floor-lod.ts';

export interface LayoutRequest {id:number;source:Parameters<typeof buildInterior>[0]}
export type LayoutResponse = {id:number;floors:ReturnType<typeof partitionInterior>;openings:ReturnType<typeof buildInterior>['openings']} |
  {id:number;error:string};

self.onmessage=({data:{id,source}}:MessageEvent<LayoutRequest>)=>{
  try {
    const interior=buildInterior(source);
    self.postMessage({id,floors:partitionInterior(interior),openings:interior.openings} satisfies LayoutResponse);
  } catch (error) {
    self.postMessage({id,error:error instanceof Error?error.message:String(error)} satisfies LayoutResponse);
  }
};
