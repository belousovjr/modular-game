"""Cache USGS 3DEP EPQS samples; offline generation never requests the network."""
import concurrent.futures, json, urllib.request
from pathlib import Path
from datetime import date
config=json.loads(Path('src/modules/world/data/downtown/district.json').read_text())
WEST,SOUTH,EAST,NORTH=config['bounds']
N=config['elevationGridSize']
out=Path('src/modules/world/data/downtown/elevation.json')
if out.exists() and json.loads(out.read_text())['bounds']==config['bounds']:
    print('Using cached',out)
    raise SystemExit

def sample(i):
    x,z=i%N,i//N
    lon=WEST+(EAST-WEST)*x/(N-1);lat=SOUTH+(NORTH-SOUTH)*z/(N-1)
    url=f'https://epqs.nationalmap.gov/v1/json?x={lon}&y={lat}&units=Meters&wkid=4326&includeDate=false'
    with urllib.request.urlopen(url,timeout=40) as r:data=json.load(r)
    height=float(data['value'])
    if not 165<height<205:raise ValueError(f'Invalid USGS sample: {data}')
    return {'lon':lon,'lat':lat,'height':height,'rasterId':data['rasterId'],'resolution':data['resolution']}
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:samples=list(pool.map(sample,range(N*N)))
out.write_text(json.dumps({'source':'USGS 3DEP EPQS','url':'https://epqs.nationalmap.gov/v1/json','date':date.today().isoformat(),'size':N,'datumOffset':config['datumOffset'],'bounds':[WEST,SOUTH,EAST,NORTH],'samples':samples},separators=(',',':'))+'\n')
print('USGS samples',len(samples),'height range',min(s['height'] for s in samples),max(s['height'] for s in samples))
