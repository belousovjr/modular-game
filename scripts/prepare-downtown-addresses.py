"""Assign OSM street addresses to the generated door panels without fetching data."""
import gzip
import json
import math
from pathlib import Path
from collections import defaultdict
from xml.etree import ElementTree as ET

DATA = Path(__file__).resolve().parents[1] / 'src/modules/world/data/downtown'


def tags(element):
    return {tag.attrib['k']: tag.attrib['v'] for tag in element.findall('tag')}


def inside(x, z, outline):
    crossed = False
    ax, az = outline[-1]
    for bx, bz in outline:
        if (az > z) != (bz > z) and x < ax + (bx - ax) * (z - az) / (bz - az):
            crossed = not crossed
        ax, az = bx, bz
    return crossed


def distance_sq(x, z, segment):
    ax, az, bx, bz = segment
    dx, dz = bx - ax, bz - az
    t = max(0, min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz or 1)))
    return (x - ax - t * dx) ** 2 + (z - az - t * dz) ** 2


def prepare(city):
    with gzip.open(DATA / 'osm-snapshot.xml.gz', 'rb') as source:
        osm = ET.parse(source).getroot()
    lon, lat = city['origin']
    longitude_scale = 111320 * math.cos(math.radians(lat))
    nodes = {
        node.attrib['id']: ((float(node.attrib['lon']) - lon) * longitude_scale,
                            (float(node.attrib['lat']) - lat) * 111320)
        for node in osm.findall('node')
    }
    direct = {}
    points = []
    anchors = defaultdict(list)
    for kind in ('node', 'way', 'relation'):
        for element in osm.findall(kind):
            metadata = tags(element)
            street, number = metadata.get('addr:street', '').strip(), metadata.get('addr:housenumber', '').strip()
            if not street or not number:
                continue
            ident = element.attrib['id']
            if kind == 'relation':
                direct['r' + ident] = (street, number)
                continue
            if kind == 'way':
                direct['w' + ident] = (street, number)
                coords = [nodes[ref.attrib['ref']] for ref in element.findall('nd') if ref.attrib['ref'] in nodes]
                if not coords:
                    continue
                x, z = (sum(axis) / len(coords) for axis in zip(*coords))
            else:
                x, z = nodes[ident]
                points.append((x, z, street, number))
            if number.isdecimal():
                anchors[street.casefold()].append((x, z, int(number)))

    streets = [(road['name'], (*a, *b)) for road in city['roads'] if road['name']
               for a, b in zip(road['points'], road['points'][1:])]
    buildings = {building['id']: building['sourceFootprint'] for building in city['buildings']}
    addresses = {}
    used = defaultdict(set)
    pending = []
    for chunk in city['chunks']:
        for detail in chunk.get('details', []):
            panel = next((mesh for mesh in detail['meshes'] if mesh['surface'] == 'facade'), None)
            if panel is None:
                continue
            ident = detail['id'].split('/detail/', 1)[1]
            vertices = panel['positions']
            x, z = (vertices[0] + vertices[9]) / 2, (vertices[2] + vertices[11]) / 2
            dx, dz = vertices[9] - vertices[0], vertices[11] - vertices[2]
            street, segment = min(streets, key=lambda road: distance_sq(x - dz, z + dx, road[1]))
            outline = buildings[ident]
            ax, az, bx, bz = min(p[0] for p in outline), min(p[1] for p in outline), max(p[0] for p in outline), max(p[1] for p in outline)
            address = direct.get(ident.split('/')[1])
            if address is None:
                matches = [p for p in points if ax <= p[0] <= bx and az <= p[1] <= bz and inside(p[0], p[1], outline)]
                if matches:
                    _, _, named, number = min(matches, key=lambda p: (p[2].casefold() != street.casefold(), (p[0] - x)**2 + (p[1] - z)**2))
                    address = (named, number)
            if address:
                named, number = address
                addresses[ident] = {'street': named, 'number': number, 'source': 'osm'}
                used[named.casefold()].add(number)
            else:
                pending.append((ident, x, z, street, segment))

    for ident, x, z, street, (ax, az, bx, bz) in pending:
        samples = anchors[street.casefold()]
        if samples:
            nearest = min(samples, key=lambda p: (p[0] - x)**2 + (p[1] - z)**2)
            axis = int(abs(bz - az) > abs(bx - ax))
            coord = (x, z)[axis]
            other = min((p for p in samples if abs(p[axis] - nearest[axis]) >= 30),
                        key=lambda p: (p[0] - x)**2 + (p[1] - z)**2, default=None)
            slope = (other[2] - nearest[2]) / (other[axis] - nearest[axis]) if other else 0
            number = max(1, round(nearest[2] + max(-1.5, min(1.5, slope)) * (coord - nearest[axis])))
        else:
            # shortcut: unnumbered named streets get local sequence numbers until source addresses are available.
            number = 1
        reserved = used[street.casefold()]
        while str(number) in reserved:
            number += 1
        reserved.add(str(number))
        addresses[ident] = {'street': street, 'number': str(number), 'source': 'estimated'}

    return addresses


if __name__ == '__main__':
    city = json.loads((DATA / 'city.json').read_text())
    addresses = prepare(city)
    (DATA / 'addresses.json').write_text(json.dumps(addresses, ensure_ascii=False, separators=(',', ':'), sort_keys=True) + '\n')
    exact = sum(address['source'] == 'osm' for address in addresses.values())
    print(f'{len(addresses)} doors: {exact} OSM, {len(addresses) - exact} estimated')
