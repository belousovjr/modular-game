"""Fetch a new bounded OSM snapshot after editing district.json. Never runs in the game."""
import gzip,json,urllib.request,xml.etree.ElementTree as ET
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
DATA=Path('src/modules/world/data/downtown');config=json.loads((DATA/'district.json').read_text())
west,south,east,north=config['bounds']
if not (-180<west<east<180 and -85<south<north<85 and east-west<.1 and north-south<.1):raise ValueError('Unsupported source extent; fetch bounded adjacent districts')
cache=Path('/tmp/modular-chicago-osm-cache');cache.mkdir(exist_ok=True)
urls=[]
for x in range(3):
 for z in range(3):
  bbox=f'{west+(east-west)*x/3},{south+(north-south)*z/3},{west+(east-west)*(x+1)/3},{south+(north-south)*(z+1)/3}'
  urls.append('https://api.openstreetmap.org/api/0.6/map?bbox='+bbox)
urls.extend(f'https://api.openstreetmap.org/api/0.6/relation/{r}/full' for r in config['riverRelations'])
def fetch(url):
 import hashlib
 path=cache/(hashlib.sha256(url.encode()).hexdigest()+'.xml')
 if not path.exists():
  request=urllib.request.Request(url,headers={'User-Agent':'ModularGame-Chicago-offline-source/1.0'})
  with urllib.request.urlopen(request,timeout=60) as r:payload=r.read()
  ET.fromstring(payload);path.write_bytes(payload)
 return ET.parse(path).getroot()
elements={}
with ThreadPoolExecutor(max_workers=2) as pool:
 for root in pool.map(fetch,urls):
  for e in root:
   if e.tag not in ['node','way','relation']:continue
   attributes={k:v for k,v in e.attrib.items() if k in ['id','lat','lon']};copy=ET.Element(e.tag,attributes)
   for child in e:
    if child.tag in ['tag','nd','member']:copy.append(ET.fromstring(ET.tostring(child)))
   elements[e.tag,e.get('id')]=copy
root=ET.Element('osm',{'version':'0.6','generator':'modular-game/offline'})
for key in sorted(elements):root.append(elements[key])
with gzip.GzipFile(str(DATA/'osm-snapshot.xml.gz'),'wb',mtime=0) as out:out.write(ET.tostring(root))
print('Snapshot entities',len(elements),'bbox',config['bounds'])
