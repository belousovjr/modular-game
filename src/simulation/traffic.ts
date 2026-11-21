// Local authority exchange. These records can also travel as JSON snapshots.
export type TrafficPoint = readonly [number,number,number];
export type TrafficRotation = readonly [number,number,number,number];
export interface TrafficSample {
  readonly id:string;
  readonly car:boolean;
  readonly point:TrafficPoint;
  readonly yaw:number;
  readonly pitch:number;
  readonly rotation?:TrafficRotation;
  readonly velocity:TrafficPoint;
}
export interface TrafficContact {
  readonly id:string;
  readonly point:TrafficPoint;
  readonly rotation:TrafficRotation;
  readonly settled:boolean;
}
