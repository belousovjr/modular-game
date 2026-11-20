"""Cache a small USGS 3DEP raster. Offline generation uses the pinned samples."""
import hashlib, io, json, sys, urllib.parse, urllib.request
from datetime import date
from pathlib import Path
from tifffile import TiffFile

out=Path('src/modules/world/data/downtown/elevation.json')
config=json.loads((out.parent/'district.json').read_text())
west,south,east,north=config['bounds']
size=config['elevationGridSize']
if out.exists():
    cached=json.loads(out.read_text())
    if cached['bounds']==config['bounds'] and cached['size']==size and cached['datumOffset']==config['datumOffset']:
        print('Using cached',out)
        raise SystemExit

dx=(east-west)/(size-1)
dz=(north-south)/(size-1)
# Export padding puts the first and last sample centres on the authored bounds.
url='https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage?'+urllib.parse.urlencode({
    'bbox':f'{west-dx/2},{south-dz/2},{east+dx/2},{north+dz/2}','bboxSR':4326,'imageSR':4326,
    'size':f'{size},{size}','adjustAspectRatio':'false','format':'tiff','pixelType':'F32',
    'interpolation':'RSP_BilinearInterpolation','f':'image',
})
if len(sys.argv)>1:
    raster=Path(sys.argv[1]).read_bytes()
else:
    with urllib.request.urlopen(url,timeout=40) as response:raster=response.read()
with TiffFile(io.BytesIO(raster)) as dem:
    page=dem.pages[0]
    cell_x,cell_z,_=page.tags['ModelPixelScaleTag'].value
    _,_,_,origin_x,origin_z,_=page.tags['ModelTiepointTag'].value
    assert all(abs(a-b)<1e-7 for a,b in [(cell_x,dx),(cell_z,dz),(origin_x,west-dx/2),(origin_z,north+dz/2)]),'Unexpected DEM grid'
    heights=page.asarray()[::-1]
    assert heights.shape==(size,size) and ((heights>165)&(heights<205)).all(),'Invalid Chicago elevation samples'

samples=[{'lon':west+x*dx,'lat':south+z*dz,'height':round(float(heights[z,x]),4)} for z in range(size) for x in range(size)]
out.write_text(json.dumps({'source':'USGS 3DEP ImageServer', 'url':url, 'rasterSha256':hashlib.sha256(raster).hexdigest(),
    'date':date.today().isoformat(),'size':size,'datumOffset':config['datumOffset'],'bounds':config['bounds'],'samples':samples},separators=(',',':'))+'\n')
print('USGS samples',len(samples),'height range',float(heights.min()),float(heights.max()))
