import type { WorldMap } from '../world/index.ts';

export const DISPLAY_SIZE = 432;
const VIEW_RADIUS_METRES = 140;
const BACKGROUND = '#132029';

export function mapHeading(x: number, z: number, previous: number) {
  return Math.hypot(x, z) < .001 ? previous : Math.atan2(x, z);
}

export function mapProjection(bounds: WorldMap['bounds']) {
  const scale = Math.min(1, 2048 / Math.max(bounds.maxX-bounds.minX,bounds.maxZ-bounds.minZ));
  return {
    scale,
    width: Math.ceil((bounds.maxX-bounds.minX)*scale),
    height: Math.ceil((bounds.maxZ-bounds.minZ)*scale),
    x: (x:number) => (x-bounds.minX)*scale,
    y: (z:number) => (bounds.maxZ-z)*scale,
  };
}

export function bakeMap(map: WorldMap) {
  const projection = mapProjection(map.bounds);
  const canvas = document.createElement('canvas');
  canvas.width = projection.width;
  canvas.height = projection.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const {x,y} = projection;
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0,0,canvas.width,canvas.height);
  // Low to high elevation in each land palette. Water is drawn before bridge decks.
  const layers = [
    ['water', ['#28586d']],
    ['urban-ground', ['#343e42','#384447','#3c484c','#424e51','#485458']],
    ['terrain', ['#385346','#3c5a49','#415f4e','#486652','#4e6d56']],
    ['rail-ballast', ['#525254']],
    ['sidewalk', ['#737574']],
    ['park-path', ['#b29a79']],
    ['road', ['#aeb7b6']],
  ] as const;
  for (const [surface, colors] of layers) {
    for (const mesh of map.surfaces) {
      if (mesh.surface !== surface) continue;
      const paths = colors.map(() => new Path2D());
      const p = mesh.positions;
      for (let i=0;i<mesh.indices.length;i+=3) {
        const a=mesh.indices[i]*3, b=mesh.indices[i+1]*3, c=mesh.indices[i+2]*3;
        const height=(p[a+1]+p[b+1]+p[c+1])/3;
        const band=Math.max(0,Math.min(colors.length-1,Math.floor(height/2)));
        const path=paths[band];
        path.moveTo(x(p[a]),y(p[a+2]));
        path.lineTo(x(p[b]),y(p[b+2]));
        path.lineTo(x(p[c]),y(p[c+2]));
        path.closePath();
      }
      paths.forEach((path,index) => { ctx.fillStyle=colors[index]; ctx.fill(path); });
    }
  }
  ctx.fillStyle='#79858c';
  for (const outline of map.buildings) {
    if (!outline.length) continue;
    ctx.beginPath();
    ctx.moveTo(x(outline[0][0]),y(outline[0][1]));
    for (const [px,pz] of outline.slice(1)) ctx.lineTo(x(px),y(pz));
    ctx.closePath();
    ctx.fill();
  }
  const zoom = (DISPLAY_SIZE/2-8)/VIEW_RADIUS_METRES;
  ctx.fillStyle='#efbc79';
  ctx.beginPath();
  for (const door of map.doors) {
    const px=x(door.x), py=y(door.z), radius=3*projection.scale/zoom;
    ctx.moveTo(px+radius,py);
    ctx.arc(px,py,radius,0,2*Math.PI);
  }
  ctx.fill();
  return (target: CanvasRenderingContext2D, px: number, pz: number, heading: number) => {
    const center = DISPLAY_SIZE/2;
    target.setTransform(1,0,0,1,0,0);
    target.clearRect(0,0,DISPLAY_SIZE,DISPLAY_SIZE);
    target.save();
    target.beginPath();
    target.arc(center,center,center-4,0,2*Math.PI);
    target.clip();
    target.fillStyle=BACKGROUND;
    target.fillRect(0,0,DISPLAY_SIZE,DISPLAY_SIZE);
    target.translate(center,center);
    target.rotate(-heading);
    target.scale(zoom/projection.scale,zoom/projection.scale);
    target.drawImage(canvas,-x(px),-y(pz));
    target.restore();
    target.strokeStyle='#a4b5ba';
    target.lineWidth=3;
    target.stroke();
    const distance=center-28;
    const nx=center-Math.sin(heading)*distance, ny=center-Math.cos(heading)*distance;
    target.fillStyle=BACKGROUND;
    target.beginPath();
    target.arc(nx,ny,17,0,2*Math.PI);
    target.fill();
    target.fillStyle='#e4f1f2';
    target.font='600 23px system-ui';
    target.textAlign='center';
    target.textBaseline='middle';
    target.fillText('С',nx,ny);
  };
}

export function makeStreetReader(map: WorldMap) {
  const segments = map.streets.flatMap(({name,points}) => name ? points.slice(1).map(([bx,bz],i) => {
    const [x,z] = points[i];
    return {name,x,z,dx:bx-x,dz:bz-z};
  }) : []);
  return (x:number,z:number) => {
    let street = '', streetDistance = 105**2;
    for (const segment of segments) {
      const {dx,dz} = segment;
      const px=x-segment.x, pz=z-segment.z;
      const fraction=Math.max(0,Math.min(1,(px*dx+pz*dz)/(dx*dx+dz*dz || 1)));
      const distance=(px-dx*fraction)**2+(pz-dz*fraction)**2;
      if (distance < streetDistance) { streetDistance=distance; street=segment.name; }
    }
    let address: WorldMap['doors'][number]['address'], doorDistance = 35**2;
    for (const door of map.doors) {
      const distance=(x-door.x)**2+(z-door.z)**2;
      if (door.address && distance < doorDistance) { doorDistance=distance; address=door.address; }
    }
    return {street,address};
  };
}
