export class LodBlend{
  readonly weights=new Map<number,number>();
  private readonly from=new Map<number,number>();
  private elapsed=0;
  target:number|null=null;
  running=false;
  readonly durationMs:number;
  constructor(durationMs:number){this.durationMs=durationMs;if(!Number.isFinite(durationMs)||durationMs<0||durationMs>500)throw new Error('Invalid LOD transition duration');}
  select(target:number|null,immediate=false){
    if(target===this.target&&!immediate)return;
    this.target=target;this.from.clear();
    if(immediate||this.durationMs===0){this.weights.clear();if(target!==null)this.weights.set(target,1);this.running=false;return;}
    for(const [index,weight]of this.weights)this.from.set(index,weight);
    if(target!==null&&!this.weights.has(target)){this.weights.set(target,0);this.from.set(target,0);}
    this.elapsed=0;this.running=this.weights.size>0;
  }
  advance(deltaMs:number){
    if(!Number.isFinite(deltaMs)||deltaMs<0)throw new Error('Invalid visual frame duration');
    if(!this.running)return;
    this.elapsed+=deltaMs;const t=Math.min(1,this.elapsed/this.durationMs),smooth=t*t*(3-2*t);
    for(const [index,from]of this.from)this.weights.set(index,from+(Number(index===this.target)-from)*smooth);
    if(t===1){this.weights.clear();if(this.target!==null)this.weights.set(this.target,1);this.from.clear();this.running=false;}
  }
}
