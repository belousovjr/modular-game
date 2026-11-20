import {buildInterior} from './shell.ts';
import {partitionInterior} from './floor-lod.ts';

export type LayoutRequest = Parameters<typeof buildInterior>[0];
export type LayoutResponse = {floors:ReturnType<typeof partitionInterior>;openings:ReturnType<typeof buildInterior>['openings']} |
  {error:string};

self.onmessage=({data:source}:MessageEvent<LayoutRequest>)=>{
  try {
    const interior=buildInterior(source);
    self.postMessage({floors:partitionInterior(interior),openings:interior.openings} satisfies LayoutResponse);
  } catch (error) {
    self.postMessage({error:error instanceof Error?error.message:String(error)} satisfies LayoutResponse);
  }
};
