type Candidate = {car:boolean;cell:string;existing:boolean;onScreen:boolean;d:number};
export const PEOPLE_LIMIT=18,CAR_LIMIT=12;

export function streetSelection<T extends Candidate>(input:T[]) {
  const selected:T[]=[],overflow:T[]=[],offscreen:T[]=[];
  const bins=new Map<string,number>();
  let cars=0,people=0;
  for (const candidate of input.sort((a,b)=>a.d-b.d)) {
    if (candidate.car) {
      if (cars++<CAR_LIMIT) selected.push(candidate);
      continue;
    }
    if (!candidate.onScreen) {offscreen.push(candidate);continue;}
    const count=bins.get(candidate.cell)??0;
    if (count>=2&&!candidate.existing) {overflow.push(candidate);continue;}
    if (people>=PEOPLE_LIMIT) continue;
    selected.push(candidate);
    bins.set(candidate.cell,count+1);
    people++;
  }
  for (const candidate of [...overflow,...offscreen]) {
    if (people>=PEOPLE_LIMIT) break;
    const count=bins.get(candidate.cell)??0;
    if (count>=4&&!candidate.existing) continue;
    selected.push(candidate);
    bins.set(candidate.cell,count+1);
    people++;
  }
  return selected;
}
