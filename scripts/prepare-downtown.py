"""Deterministic offline OSM/USGS -> tiled Chicago geometry. Python + Shapely 2.1.
Usage: PYTHONPATH=/tmp/modular-city-python python3 scripts/prepare-downtown.py
The source path and geographic bbox can be changed to extend the district.
"""
import gzip,hashlib,json,math,re,xml.etree.ElementTree as ET
from statistics import median
from pathlib import Path
from collections import defaultdict,Counter
from shapely.geometry import Polygon,LineString,Point,box
from shapely.geometry.polygon import orient
from shapely.ops import unary_union,polygonize
from shapely.prepared import prep
from shapely import constrained_delaunay_triangles
from shapely.affinity import rotate,translate,scale
ROOT=Path(__file__).resolve().parents[1];DATA=ROOT/'src/modules/world/data/downtown'
config=json.loads((DATA/'district.json').read_text())
LON,LAT=config['origin']
BBOX=config['bounds']
TILE=config['tileSize']
GRID=config['grid'];POSITION=GRID['position'];SIZE=GRID['size'];ANGLE=math.radians(GRID['rotationDegrees'])
def snap(v,step):return math.floor(v/step+.5)*step

def project(lon,lat):return (snap((lon-LON)*111320*math.cos(math.radians(LAT)),POSITION),snap((lat-LAT)*111320,POSITION))
def tags(e):return {t.get('k'):t.get('v') for t in e.findall('tag')}
def number(s,default=0):
    m=re.search(r'-?\d+(?:\.\d+)?',str(s or ''));return float(m[0]) if m else default

def polys(g):return [g] if g.geom_type=='Polygon' else [p for p in getattr(g,'geoms',[]) if p.geom_type=='Polygon']

def triangulate(p):
    if p.is_empty or p.area<1e-7:return []
    faces=list(constrained_delaunay_triangles(p).geoms)
    assert abs(sum(t.area for t in faces)-p.area)<max(1e-5,p.area*1e-7),'Triangulation lost area'
    return [list(t.exterior.coords)[:3] for t in faces]

source=DATA/'osm-snapshot.xml.gz'
nodes={};ways={};relations={};node_tags={}
with gzip.open(source,'rb') as f:elements=ET.parse(f).getroot()
for e in elements:
    ident=e.get('id')
    if e.tag=='node':nodes[ident]=project(float(e.get('lon')),float(e.get('lat')));node_tags[ident]=tags(e)
    elif e.tag=='way':ways[ident]=(tags(e),[n.get('ref') for n in e.findall('nd')])
    elif e.tag=='relation':relations[ident]=(tags(e),[(m.get('ref'),m.get('role','')) for m in e.findall('member') if m.get('type')=='way'])
def coords(refs):return [nodes[r] for r in refs if r in nodes]
def polygon(refs):
    c=coords(refs)
    return Polygon(c).buffer(0) if len(c)>=4 and c[0]==c[-1] else Polygon()
bounds=box(*project(BBOX[0],BBOX[1]),*project(BBOX[2],BBOX[3]))
minx,minz,maxx,maxz=bounds.bounds
water=[];buildings=[];members_seen=set()
for ident,(t,members) in sorted(relations.items()):
    river=t.get('natural')=='water' and t.get('water')=='river'
    if not river and not t.get('building'):continue
    lines=[LineString(coords(ways[r][1])) for r,role in members if role!='inner' and r in ways and len(coords(ways[r][1]))>=2]
    inners=[polygon(ways[r][1]) for r,role in members if role=='inner' and r in ways]
    for p in polygonize(unary_union(lines)):
        p=p.difference(unary_union(inners)).intersection(bounds)
        if river:water.extend(polys(p))
        else:buildings.extend((f'osm/r{ident}/{i}',t,q) for i,q in enumerate(polys(p)));members_seen.update(r for r,_ in members)
for ident,(t,refs) in sorted(ways.items()):
    if t.get('natural')=='water' and t.get('water')=='river':water.extend(polys(polygon(refs).intersection(bounds)))
    if t.get('building') and ident not in members_seen and t['building'] not in ['roof','construction','shed','service']:
        buildings.extend((f'osm/w{ident}/{i}',t,p) for i,p in enumerate(polys(polygon(refs).intersection(bounds))))
print('Source parsed',len(nodes),len(ways),flush=True)
water=unary_union(water).simplify(.25,preserve_topology=True).buffer(0)
assert water.area>10000,'Missing river'
elevation=json.loads((DATA/'elevation.json').read_text());assert elevation['bounds']==BBOX,'Refresh elevation after changing district bounds';N=elevation['size'];heights=[snap(s['height']-elevation['datumOffset'],SIZE) for s in elevation['samples']]
def terrain_raw(x,z):
    u=max(0,min(N-1,(x-minx)/(maxx-minx)*(N-1)));v=max(0,min(N-1,(z-minz)/(maxz-minz)*(N-1)))
    ix=min(N-2,int(u));iz=min(N-2,int(v));a=u-ix;b=v-iz
    return max(1.5,(1-b)*((1-a)*heights[iz*N+ix]+a*heights[iz*N+ix+1])+b*((1-a)*heights[(iz+1)*N+ix]+a*heights[(iz+1)*N+ix+1]))
# Every surface uses the same piecewise planar terrain, including shared diagonals.
STEP=32
def terrain(x,z):
    gx=math.floor(x/STEP)*STEP;gz=math.floor(z/STEP)*STEP
    u=(x-gx)/STEP;v=(z-gz)/STEP
    a=terrain_raw(gx,gz);b=terrain_raw(gx+STEP,gz);c=terrain_raw(gx,gz+STEP)
    if u+v<=1:return a+(b-a)*u+(c-a)*v
    d=terrain_raw(gx+STEP,gz+STEP)
    return d+(c-d)*(1-u)+(b-d)*(1-v)

def terrain_faces(shape):
    if shape.is_empty:return []
    x0,z0,x1,z1=shape.bounds;result=[]
    for x in range(math.floor(x0/STEP)*STEP,math.ceil(x1/STEP)*STEP,STEP):
     for z in range(math.floor(z0/STEP)*STEP,math.ceil(z1/STEP)*STEP,STEP):
        patch=shape.intersection(box(x,z,x+STEP,z+STEP))
        if patch.area<1e-7:continue
        if abs(terrain_raw(x,z)+terrain_raw(x+STEP,z+STEP)-terrain_raw(x+STEP,z)-terrain_raw(x,z+STEP))<1e-8:
            result.extend(triangulate(patch))
        else:
            for triangle in [Polygon([(x,z),(x+STEP,z),(x,z+STEP)]),Polygon([(x+STEP,z),(x+STEP,z+STEP),(x,z+STEP)])]:
                result.extend(triangulate(patch.intersection(triangle)))
    return result

# River level and bathymetry are artistic reference parameters, not surveyed soundings.
WATER=config['waterLevel']
shore=water.boundary
def bed(x,z):
    d=shore.distance(Point(x,z));depth=d if d<=12 else 12+6*(1-math.exp(-(d-12)/6))
    return WATER-1-depth+(.12*math.sin(x/42)+.1*math.cos(z/37))*(1-math.exp(-d/12))
roads=[];road_shapes=[];pavements=[];node_roads=defaultdict(list)
classes={'trunk','primary','secondary','tertiary','residential','unclassified','trunk_link','primary_link','secondary_link','tertiary_link'}
for ident,(t,refs) in sorted(ways.items()):
    if t.get('highway') not in classes or t.get('tunnel')=='yes' or number(t.get('layer'))<0:continue
    c=coords(refs)
    if len(set(c))<2:continue
    line=LineString(c).intersection(bounds)
    segments=[line] if line.geom_type=='LineString' else [g for g in getattr(line,'geoms',[]) if g.geom_type=='LineString']
    lanes=max(1,min(8,number(t.get('lanes'),2 if t.get('oneway')=='yes' else 3)))
    width=max(6,min(36,number(t.get('width'),lanes*3.2+3)))
    for i,line in enumerate(segments):
        if line.length<1:continue
        bridge=t.get('bridge') in ['yes','movable'] or line.intersects(water)
        r={'id':f'osm/w{ident}/{i}','name':t.get('name',''),'points':[[snap(x,POSITION),snap(z,POSITION)] for x,z in line.coords], 'width':round(width,2),'lanes':lanes,'oneway':t.get('oneway','no'),'bridge':bridge,'layer':number(t.get('layer')),'widthSource':'osm' if t.get('width') else 'lanes-estimate'}
        roads.append(r);road_shapes.append(line.buffer(width/2,cap_style='flat',join_style='mitre'))
        pavements.append(line.buffer(width/2+3.2,cap_style='flat',join_style='mitre'))
    for ref in refs:node_roads[ref].append((ident,t,width))
# Normalise incomplete lane tags along a named street instead of making width jump at every OSM way.
width_groups=defaultdict(list)
for r in roads:width_groups[r['name'] or r['id'],r['oneway'],r['layer']].append(r['width'])
road_shapes=[]
for r in roads:
    if r['widthSource']!='osm':r['width']=median(width_groups[r['name'] or r['id'],r['oneway'],r['layer']])
    r['width']=snap(r['width'],SIZE)
    line=LineString(r['points']).simplify(POSITION*.75)
    r['points']=[list(p) for p in line.coords]
    road_shapes.append(line.buffer(r['width']/2,cap_style='round',join_style='round',quad_segs=3))
road=unary_union(road_shapes).intersection(bounds).buffer(0).simplify(.06,preserve_topology=True)
pavement=road.buffer(3.25,join_style='round',quad_segs=3).intersection(bounds).simplify(.025,preserve_topology=True)
# One clean pavement outline produces consistent sidewalk widths and intersection corners.
sidewalk=pavement.difference(road).difference(water.difference(road.buffer(3.3)))
land=bounds.difference(water)
parks=unary_union([polygon(refs) for t,refs in ways.values() if t.get('leisure') in ['park','garden'] or t.get('landuse')=='grass']).intersection(land).difference(pavement)
ground=land.difference(pavement).difference(parks)
curb=road.buffer(.25,join_style='round',quad_segs=3).difference(road).intersection(sidewalk)
sidewalk=sidewalk.difference(curb)
assert road.intersection(sidewalk).area<1e-5 and curb.intersection(sidewalk).area<1e-5,'Overlapping street surfaces'
print('Road boolean operations complete',len(roads),flush=True)
chunks={};colliders=[];building_data=[];placements=[];counts=Counter()
def chunk(ix,iz):
    key=f'{ix}/{iz}'
    if key not in chunks:chunks[key]={'id':f"{config['id']}/{key}",'bounds':{'minX':max(minx,ix*TILE),'maxX':min(maxx,(ix+1)*TILE),'minZ':max(minz,iz*TILE),'maxZ':min(maxz,(iz+1)*TILE)},'meshes':[],'buildingIds':[]}
    return chunks[key]
def mesh(surface,triangles,fn,ix,iz):
    if not triangles:return
    positions=[];indices=[];lookup={}
    for tri in triangles:
        ids=[]
        # Up-facing triangles in Babylon's left-handed scene.
        a,b,c=tri
        if (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])<0:tri=[a,c,b]
        for x,z in tri:
            key=(round(x,4),round(z,4));y=round(fn(*key),4);vertex=(*key,y)
            if vertex not in lookup:lookup[vertex]=len(positions)//3;positions.extend([key[0],y,key[1]])
            ids.append(lookup[vertex])
        indices.extend(ids)
    chunk(ix,iz)['meshes'].append({'surface':surface,'positions':positions,'indices':indices});counts[surface]+=len(indices)//3
# 32m terrain facets match the sampled DEM; bed uses 8m cells near the banks.
for ix in range(math.floor(minx/TILE),math.ceil(maxx/TILE)):
 for iz in range(math.floor(minz/TILE),math.ceil(maxz/TILE)):
    tile=box(ix*TILE,iz*TILE,(ix+1)*TILE,(iz+1)*TILE).intersection(bounds)
    for surface,shape,fn,step in [('urban-ground',ground,terrain,32),('terrain',parks,terrain,32),('road',road,lambda x,z:terrain(x,z),32),('sidewalk',sidewalk,lambda x,z:terrain(x,z)+SIZE,32),('curb',curb,lambda x,z:terrain(x,z)+SIZE,32),('water',water,lambda x,z:WATER,128),('riverbed',water,bed,8)]:
        patch=shape.intersection(tile)
        if patch.area<1e-7:continue
        triangles=[]
        if surface=='water':
            triangles=triangulate(patch)
        elif surface!='riverbed':
            triangles=terrain_faces(patch)
        else:
            x0,z0,x1,z1=patch.bounds
            for x in range(math.floor(x0/step)*step,math.ceil(x1/step)*step,step):
             for z in range(math.floor(z0/step)*step,math.ceil(z1/step)*step,step):
                triangles.extend(triangulate(patch.intersection(box(x,z,x+step,z+step))))
        mesh(surface,triangles,fn,ix,iz)
# Watertight bank faces and structural bridge edges share the exact clipped shoreline.
def edge_points(ring):
    result=[];points=list(LineString(ring.coords).segmentize(STEP).coords)
    for a,b in zip(points,points[1:]):
        cuts={0.,1.}
        for av,bv in [(a[0],b[0]),(a[1],b[1]),(sum(a),sum(b))]:
            if abs(bv-av)<1e-10:continue
            for k in range(math.floor(min(av,bv)/STEP)+1,math.ceil(max(av,bv)/STEP)):
                t=(k*STEP-av)/(bv-av)
                if 0<t<1:cuts.add(t)
        result.extend((a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t) for t in sorted(cuts)[:-1])
    result.append(points[-1]);return result

def edge_mesh(shape,surface,top,bottom):
    batches={}
    for p in polys(shape):
      p=orient(p,sign=-1)
      for ring in [p.exterior,*p.interiors]:
        c=edge_points(ring)
        for a,b in zip(c,c[1:]):
            ix=math.floor((a[0]+b[0])/2/TILE);iz=math.floor((a[1]+b[1])/2/TILE)
            target=batches.setdefault((ix,iz),{'surface':surface,'positions':[],'indices':[]})
            n=len(target['positions'])//3
            for x,z,y in [(a[0],a[1],top(*a)),(b[0],b[1],top(*b)),(b[0],b[1],bottom(*b)),(a[0],a[1],bottom(*a))]:target['positions'].extend([round(x,4),round(y,4),round(z,4)])
            target['indices'].extend([n,n+1,n+2,n,n+2,n+3])
    for (ix,iz),data in batches.items():
        meshes=chunk(ix,iz)['meshes'];existing=next((m for m in meshes if m['surface']==surface),None)
        if existing is None:meshes.append(data)
        else:
            offset=len(existing['positions'])//3;existing['positions'].extend(data['positions']);existing['indices'].extend(i+offset for i in data['indices'])
        counts[surface]+=len(data['indices'])//3
edge_mesh(curb,'curb',lambda x,z:terrain(x,z)+SIZE,lambda x,z:terrain(x,z))
edge_mesh(pavement.difference(water.difference(road.buffer(3.3))),'sidewalk',lambda x,z:terrain(x,z)+SIZE,terrain)
edge_mesh(water,'bank',terrain,bed)
edge_mesh(road.intersection(water.buffer(2)),'bank',lambda x,z:terrain(x,z),lambda x,z:terrain(x,z)-.7)
buildable=land.difference(pavement.buffer(.25))
buildable_cover=prep(buildable.buffer(.03))
print('Tiled surfaces prepared',dict(counts),flush=True)
# Buildings retain original footprints. No invented buildings in road/river gaps.
occupied=defaultdict(list);unique_ids=Counter()
landmarks={'willis tower':('willis',442),'trump international':('trump',423),'marina city':('marina',179),'wrigley building':('wrigley',134),'tribune tower':('tribune',141)}
for ident,t,p in sorted(buildings,key=lambda r:r[0]):
    if p.area<70:continue
    footprint=p.intersection(buildable)
    if footprint.area<70 or footprint.area<p.area*.45:continue
    h=number(t.get('height'));method='osm-height'
    if 'ft' in t.get('height','') or "'" in t.get('height',''):h*=.3048
    if not h:h=number(t.get('building:levels'))*3.5;method='osm-levels'
    if not h:h=24 if p.area<600 else 55;method='estimated'
    profile='stone' if h<65 else 'glass'
    for name,(family,height) in landmarks.items():
        if name in t.get('name','').lower():profile=family;h=height;method='landmark-reference'
    for n,p in enumerate(polys(footprint)):
        clean=p.simplify(.12,preserve_topology=True).intersection(p)
        p=orient(clean if clean.geom_type=='Polygon' and not clean.is_empty else p,sign=-1)
        rect=p.minimum_rotated_rectangle;cs=list(rect.exterior.coords);width=math.dist(cs[0],cs[1]);depth=math.dist(cs[1],cs[2]);center=rect.centroid
        if min(width,depth)<3:continue
        yaw=-math.atan2(cs[1][1]-cs[0][1],cs[1][0]-cs[0][0])
        # Fit the reusable architectural envelope inside the real footprint, never into a road.
        fit=p if profile in ['stone','glass'] else rect
        for _ in range(0 if profile in ['stone','glass'] else 24):
            if p.buffer(.05).covers(fit):break
            fit=scale(fit,.94,.94,origin=center);width*=.94;depth*=.94
        if not p.buffer(.05).covers(fit) or min(width,depth)<3:continue
        # Snap the entire footprint as one module; resolve placements on the same coarse map grid.
        old=center;target_x=snap(center.x,POSITION);target_z=snap(center.y,POSITION);target_yaw=snap(yaw,ANGLE)
        candidate=rotate(fit,math.degrees(yaw-target_yaw),origin=old)
        candidate=translate(candidate,target_x-old.x,target_z-old.y)
        # Keep coarse placement and orientation, shrink by quarter-metre steps if it touches a street.
        found=None
        offsets=sorted([(x,z) for x in range(-2,3) for z in range(-2,3)],key=lambda p:(p[0]*p[0]+p[1]*p[1],p))
        for shrink in range(32):
            ratio_x=max(3,snap(width,SIZE)-shrink*SIZE)/width;ratio_z=max(3,snap(depth,SIZE)-shrink*SIZE)/depth
            scaled=scale(rotate(candidate,math.degrees(target_yaw),origin=(target_x,target_z)),ratio_x,ratio_z,origin=(target_x,target_z))
            scaled=rotate(scaled,-math.degrees(target_yaw),origin=(target_x,target_z))
            for ox,oz in offsets:
                fitted=translate(scaled,ox*POSITION,oz*POSITION)
                if not buildable_cover.covers(fitted):continue
                fc=fitted.bounds;cells1=[(ix,iz) for ix in range(math.floor(fc[0]/TILE),math.floor(fc[2]/TILE)+1) for iz in range(math.floor(fc[1]/TILE),math.floor(fc[3]/TILE)+1)]
                if any(fitted.intersection(other).area>.1 for cell in cells1 for other in occupied[cell]):continue
                found=(fitted,target_x+ox*POSITION,target_z+oz*POSITION);break
            if found:break
        if found is None:continue
        fitted,target_x,target_z=found
        fit=fitted;p=orient(fit,sign=-1);width=snap(width*ratio_x,SIZE);depth=snap(depth*ratio_z,SIZE);h=max(3,snap(h,SIZE));yaw=target_yaw
        bx,bz=target_x,target_z;by=math.ceil(max(terrain(x,z) for x,z in list(fit.exterior.coords))/SIZE)*SIZE
        outline=[[round(x,4),round(z,4)] for x,z in list(fit.exterior.coords)[:-1]]
        unique_ids[ident]+=1
        oid=f'{ident}/{n}/{unique_ids[ident]}'
        cells=[(ix,iz) for ix in range(math.floor(fit.bounds[0]/TILE),math.floor(fit.bounds[2]/TILE)+1) for iz in range(math.floor(fit.bounds[1]/TILE),math.floor(fit.bounds[3]/TILE)+1)]
        if any(fit.intersection(other).area>.1 for cell in cells for other in occupied[cell]):continue
        for cell in cells:occupied[cell].append(fit)
        if profile in ['stone','glass']:
            tile_chunk=chunk(math.floor(bx/TILE),math.floor(bz/TILE));surface=f'city-{profile}'
            tile_chunk['buildingIds'].append(oid)
            batch=next((m for m in tile_chunk['meshes'] if m['surface']==surface),None)
            if batch is None:batch={'surface':surface,'positions':[],'indices':[],'uvs':[]};tile_chunk['meshes'].append(batch)
            def quad(a,b,c,d,uvs):
                offset=len(batch['positions'])//3
                for (vx,vy,vz),(u,v) in zip([a,b,c,d],uvs):
                    batch['positions'].extend([round(vx,4),round(vy,4),round(vz,4)]);batch['uvs'].extend([u,v])
                batch['indices'].extend(offset+i for i in [0,1,2,0,2,3])
            def cap(shape,y,code,down=False):
                cache={}
                for tri in triangulate(shape):
                    a,b,c=tri
                    if ((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])<0)!=down:tri=[a,c,b]
                    for x,z in tri:
                        key=(round(x,4),round(z,4))
                        if key not in cache:
                            cache[key]=len(batch['positions'])//3;batch['positions'].extend([key[0],round(y,4),key[1]]);batch['uvs'].extend([code,code])
                        batch['indices'].append(cache[key])
            bottom=by+.5;top=by+h-.5;rows=max(1,round((top-bottom)/3.5));storey=(top-bottom)/rows
            inset=p.buffer(-SIZE,join_style='mitre')
            if inset.is_empty:inset=p
            # Vertical faces map complete window cells to each edge, independent of world orientation/phase.
            for wall in polys(inset):
             wall=orient(wall,sign=-1)
             for ring in [wall.exterior,*wall.interiors]:
              for (ax,az),(bx1,bz1) in zip(list(ring.coords),list(ring.coords)[1:]):
                columns=max(1,round(math.hypot(bx1-ax,bz1-az)/2.8))
                uv=[(0,0),(0,rows),(columns,rows),(columns,0)] if math.hypot(bx1-ax,bz1-az)>=1.2 else [(-3,-3)]*4
                quad((ax,bottom,az),(ax,top,az),(bx1,top,bz1),(bx1,bottom,bz1),uv)
            rim=p.difference(inset)
            cap(p,by+h,-2);cap(rim,bottom,-3);cap(rim,top,-3,down=True)
            # Plinth and roof edge project only 10 cm beyond the recessed wall; footprint is unchanged.
            for ring in [p.exterior,*p.interiors]:
             for (ax,az),(bx1,bz1) in zip(list(ring.coords),list(ring.coords)[1:]):
                low=min(terrain(ax,az),terrain(bx1,bz1))-1
                quad((ax,low,az),(ax,bottom,az),(bx1,bottom,bz1),(bx1,low,bz1),[(-1,-1)]*4)
                quad((ax,top,az),(ax,by+h,az),(bx1,by+h,bz1),(bx1,top,bz1),[(-3,-3)]*4)
            # Two slim belts on the longest facade, not a ring around every tiny footprint edge.
            if rows>=5:
             edges=list(zip(list(p.exterior.coords),list(p.exterior.coords)[1:]));a,b=max(edges,key=lambda e:math.dist(*e))
             length=math.dist(a,b);nx=-(b[1]-a[1])/length;nz=(b[0]-a[0])/length
             for level in sorted({1,max(2,round(rows*.65))}):
                y=bottom+level*storey;ax,az=a;bx1,bz1=b;ix,iz=ax-nx*SIZE,az-nz*SIZE;jx,jz=bx1-nx*SIZE,bz1-nz*SIZE
                uv=[(-3,-3)]*4
                quad((ax,y-SIZE/2,az),(ax,y+SIZE/2,az),(bx1,y+SIZE/2,bz1),(bx1,y-SIZE/2,bz1),uv)
                quad((ax,y+SIZE/2,az),(ix,y+SIZE/2,iz),(jx,y+SIZE/2,jz),(bx1,y+SIZE/2,bz1),uv)
                quad((ix,y-SIZE/2,iz),(ax,y-SIZE/2,az),(bx1,y-SIZE/2,bz1),(jx,y-SIZE/2,jz),uv)
                quad((ax,y-SIZE/2,az),(ix,y-SIZE/2,iz),(ix,y+SIZE/2,iz),(ax,y+SIZE/2,az),uv)
                quad((jx,y-SIZE/2,jz),(bx1,y-SIZE/2,bz1),(bx1,y+SIZE/2,bz1),(jx,y+SIZE/2,jz),uv)
        placements.append({'key':oid,'templateId':f'city/{profile}','parameters':{'width':round(width,3),'depth':round(depth,3),'height':round(max(6,min(600,h)),2),'foundation':math.ceil(max(2,by-min(terrain(x,z) for x,z in list(fit.exterior.coords))+1)/SIZE)*SIZE},'position':[round(bx,3),round(by,4),round(bz,3)],'rotation':[0,round(yaw,8),0]})
        colliders.append({'id':oid,'minX':min(x for x,z in outline),'maxX':max(x for x,z in outline),'minZ':min(z for x,z in outline),'maxZ':max(z for x,z in outline),'minY':by-2,'maxY':by+h,'outline':outline})
        building_data.append({'id':oid,'name':t.get('name',''),'profile':profile,'height':h,'heightSource':method,'sourceFootprint':[[round(x,3),round(z,3)] for x,z in list(p.exterior.coords)]})
print('Building placement complete',len(colliders),flush=True)
# Mapped signals and actual connected junctions, with approach-facing crosswalks.
intersection_ids={n for n,rs in node_roads.items() if len({r[0] for r in rs})>=3}
signals=[];crossings=[]
sidewalk_near=prep(sidewalk.buffer(.6));road_expanded=prep(road.buffer(.02));water_near=prep(water.buffer(2));inner_bounds=prep(bounds.buffer(-12))
for nid in sorted(set(intersection_ids)|{n for n,t in node_tags.items() if t.get('highway')=='traffic_signals'}):
    if nid not in nodes or nid not in node_roads:continue
    x,z=nodes[nid]
    if not inner_bounds.contains(Point(x,z)) or water_near.contains(Point(x,z)):continue
    approaches=[]
    for wid,t,width in node_roads[nid]:
        refs=ways[wid][1]
        for j,ref in enumerate(refs):
            if ref!=nid:continue
            for k in [j-1,j+1]:
                if 0<=k<len(refs) and refs[k] in nodes:
                    q=nodes[refs[k]];dx=q[0]-x;dz=q[1]-z;length=math.hypot(dx,dz)
                    if length<1:continue
                    direction=(dx/length,dz/length,width)
                    if not any(direction[0]*a[0]+direction[1]*a[1]>.97 for a in approaches):approaches.append(direction)
    if len(approaches)<2:continue
    radius=max(a[2] for a in approaches)/2+3
    for j,(dx,dz,width) in enumerate(approaches):
        # Signal heads sit on the downstream sidewalk corner, away from the crossing stripes.
        sx=snap(x+dx*(radius+2)-dz*(width/2+1.3),POSITION);sz=snap(z+dz*(radius+2)+dx*(width/2+1.3),POSITION)
        if sidewalk_near.contains(Point(sx,sz)):
            signals.append({'key':f'osm/signal/{nid}/{j}','templateId':'city/signal','parameters':{},'position':[round(sx,3),math.ceil((terrain(sx,sz)+SIZE)/SIZE)*SIZE,round(sz,3)],'rotation':[0,snap(math.atan2(dx,dz)+math.pi,ANGLE),0]})
        cx=x+dx*radius;cz=z+dz*radius
        for k in range(-int(width/2)+1,int(width/2),2):
            px=cx-dz*k;pz=cz+dx*k
            stripe=Polygon([(px-dx*1.5-dz*.4,pz-dz*1.5+dx*.4),(px+dx*1.5-dz*.4,pz+dz*1.5+dx*.4),(px+dx*1.5+dz*.4,pz+dz*1.5-dx*.4),(px-dx*1.5+dz*.4,pz-dz*1.5-dx*.4)])
            if road_expanded.covers(stripe):crossings.append(stripe)
# Mark lane centres only outside junctions; mapped separate carriageways stay separate.
junction_mask=unary_union([Point(nodes[n]).buffer(20) for n in intersection_ids if n in nodes])
markings=[]
for r in roads:
    line=LineString(r['points'])
    if r['oneway']=='no' and r['width']>=9:
        markings.extend(polys(line.buffer(.065).difference(junction_mask)))
marking=unary_union(markings+crossings)
for ix in range(math.floor(minx/TILE),math.ceil(maxx/TILE)):
 for iz in range(math.floor(minz/TILE),math.ceil(maxz/TILE)):
    patch=marking.intersection(box(ix*TILE,iz*TILE,(ix+1)*TILE,(iz+1)*TILE))
    mesh('marking',terrain_faces(patch),lambda x,z:terrain(x,z)+.015,ix,iz)
lamps=[];lamp_cells=defaultdict(list)
for r in roads:
    line=LineString(r['points'])
    for distance in range(18,int(line.length)-12,32):
        p=line.interpolate(distance);q=line.interpolate(min(line.length,distance+1));dx=q.x-p.x;dz=q.y-p.y;length=math.hypot(dx,dz)
        if length<.01:continue
        for side in [-1,1]:
            offset=(r['width']/2+1.3)*side;lx=p.x-dz/length*offset;lz=p.y+dx/length*offset;point=Point(lx,lz)
            lx=snap(lx,POSITION);lz=snap(lz,POSITION);point=Point(lx,lz)
            cell=(math.floor(lx/12),math.floor(lz/12))
            if not inner_bounds.contains(point) or not sidewalk_near.contains(point) or junction_mask.distance(point)<4 or water_near.contains(point):continue
            if any(point.distance(other)<12 for ix in range(cell[0]-1,cell[0]+2) for iz in range(cell[1]-1,cell[1]+2) for other in lamp_cells[ix,iz]):continue
            lamp_cells[cell].append(point)
            lamps.append({'key':f"osm/lamp/{r['id']}/{distance}/{side}",'templateId':'world/lamp','parameters':{},'position':[round(lx,3),math.ceil((terrain(lx,lz)+SIZE)/SIZE)*SIZE,round(lz,3)],'rotation':[0,snap(math.atan2(-side*dx,-side*dz),ANGLE),0]})
placements.extend(lamps)
placements.extend(signals)
# A dry, wide, unobstructed road segment supports the existing 4x4 crowd test.
candidates=[]
for r in roads:
    line=LineString(r['points']);point=line.interpolate(.5,normalized=True)
    if r['width']>=12 and line.length>25 and road.covers(point.buffer(3.5)) and not water.buffer(20).intersects(point):candidates.append(point)
assert candidates,'No safe spawn'
spawn=min(candidates,key=lambda p:p.distance(Point(0,0)))
print('Markings and signals complete',len(signals),len(crossings),flush=True)
# Keep source derivation and key counts inspectable; no remote source is needed at runtime.
counts=Counter()
for ch in chunks.values():
    for m in ch['meshes']:counts[m['surface']]+=len(m['indices'])//3
result={'version':1,'id':config['id'],'origin':[LON,LAT],'geographicBounds':BBOX,'bounds':{'minX':minx,'maxX':maxx,'minZ':minz,'maxZ':maxz},'spawn':{'x':snap(spawn.x,POSITION),'z':snap(spawn.y,POSITION)},'waterLevel':WATER,'roads':roads,'chunks':list(chunks.values()),'placements':placements,'colliders':colliders,'buildings':building_data,'grid':GRID,'source':{'osmSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'attribution':'© OpenStreetMap contributors','licence':'ODbL-1.0','elevation':'USGS 3DEP; bilinear 9x9 samples; NAVD88 datum offset 180 m','bathymetry':'procedural reference profile, not survey data'},'report':{'buildings':len(colliders),'roads':len(roads),'signals':len(signals),'lamps':len(lamps),'junctions':len(intersection_ids),'crossingStripes':len(crossings),'riverArea':round(water.area,2),'triangles':dict(counts),'chunks':len(chunks)}}
(DATA/'city.json').write_text(json.dumps(result,separators=(',',':'),ensure_ascii=False)+'\n')
print(json.dumps(result['report']));print('spawn',result['spawn']);print('bytes',(DATA/'city.json').stat().st_size)

from xml.sax.saxutils import escape
svg=[f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{minx} {-maxz} {maxx-minx} {maxz-minz}" width="1200" height="1050"><rect x="{minx}" y="{-maxz}" width="{maxx-minx}" height="{maxz-minz}" fill="#e6e1d4"/>']
for p in polys(water):
    pts=' '.join(f'{x:.2f},{-z:.2f}' for x,z in p.exterior.coords);svg.append(f'<polygon points="{pts}" fill="#4b9399"/>')
for r in roads:
    pts=' '.join(f'{x},{-z}' for x,z in r['points']);svg.append(f'<polyline points="{pts}" fill="none" stroke="#68717b" stroke-width="{r["width"]}"/>')
for b in building_data:
    pts=' '.join(f'{x},{-z}' for x,z in b['sourceFootprint']);svg.append(f'<polygon points="{pts}" fill="#a38664"><title>{escape(b["name"])}</title></polygon>')
svg.append(f'<circle cx="{spawn.x}" cy="{-spawn.y}" r="8" fill="#e33"/><text x="{minx+15}" y="{-minz-15}" font-size="18">© OpenStreetMap contributors · ODbL · north ↑</text></svg>')
(ROOT/'public/maps/downtown.svg').write_text(''.join(svg))
