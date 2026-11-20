"""Prepare compact interior-facing profiles from the authored door and facade geometry."""
import json
import math
from pathlib import Path

DATA = Path(__file__).resolve().parents[1] / 'src/modules/world/data/downtown'


def footprint_area(outline):
    edges = zip(outline, outline[1:] + outline[:1])
    return abs(sum(ax * bz - bx * az for (ax, az), (bx, bz) in edges)) / 2


def footprint_shape(outline, width, depth, area):
    fill = area / (width * depth)
    if fill >= .9:
        return 'rectangular'
    if len(outline) >= 8 and .66 <= fill <= .88:
        center_x = (min(x for x, _ in outline) + max(x for x, _ in outline)) / 2
        center_z = (min(z for _, z in outline) + max(z for _, z in outline)) / 2
        if all(abs(math.hypot(2 * (x - center_x) / width, 2 * (z - center_z) / depth) - 1) <= .18 for x, z in outline):
            return 'round' if max(width, depth) / min(width, depth) <= 1.2 else 'oval'
    return 'complex'


def prepare_profiles(city):
    placements = {p['key']: p for p in city['placements']}
    colliders = {c['id']: c for c in city['colliders']}
    profiles = {}
    for chunk in city['chunks']:
        for detail in chunk.get('details', []):
            door = next((m for m in detail['meshes'] if m['surface'] == 'facade'), None)
            if door is None:
                continue
            ident = detail['id'].split('/detail/', 1)[1]
            placement = placements[ident]
            collider = colliders[ident]
            shell = next(m for m in detail['meshes'] if m['surface'].endswith('-detail'))
            ox, oy, oz = placement['position']
            yaw = placement['rotation'][1]
            cosine, sine = math.cos(yaw), math.sin(yaw)

            def local(x, z):
                return [round((x - ox) * cosine - (z - oz) * sine, 3),
                        round((x - ox) * sine + (z - oz) * cosine, 3)]

            outline = [local(x, z) for x, z in collider['outline']]
            if outline[0] == outline[-1]:
                outline.pop()
            width = max(x for x, _ in outline) - min(x for x, _ in outline)
            depth = max(z for _, z in outline) - min(z for _, z in outline)
            height = collider['maxY'] - oy
            bottom, top = oy + .5, collider['maxY'] - .5
            floors = 0
            facades = []
            positions, indices, uvs = shell['positions'], shell['indices'], shell['uvs']
            for i in range(0, len(indices) - 5, 3):
                a, b, c, _, _, d = indices[i:i + 6]
                if [b, c, d] != [a + 1, a + 2, a + 3]:
                    continue
                if abs(positions[a * 3 + 1] - bottom) > .001 or abs(positions[b * 3 + 1] - top) > .001:
                    continue
                if positions[b * 3 + 1] != positions[c * 3 + 1] or positions[a * 3 + 1] != positions[d * 3 + 1]:
                    continue
                start = local(positions[a * 3], positions[a * 3 + 2])
                end = local(positions[d * 3], positions[d * 3 + 2])
                if start == end:
                    continue
                columns = round(uvs[d * 2] - uvs[a * 2]) if uvs[a * 2] >= 0 else 0
                if columns:
                    floors = round(uvs[b * 2 + 1] - uvs[a * 2 + 1])
                facades.append({'start': start, 'end': end, 'windowColumns': columns})

            # The geometric facade stays the source of truth even when some short walls are blind.
            assert facades and floors > 0, f'Missing facade grid for {ident}'
            p = door['positions']
            center = local((p[0] + p[9]) / 2, (p[2] + p[11]) / 2)
            door_width = math.hypot(p[9] - p[0], p[11] - p[2])
            door_start, door_end = local(p[0], p[2]), local(p[9], p[11])
            # The portal sits ahead of its wall. Match parallel edges before comparing distance.
            nearest = None
            for index, wall in enumerate(facades):
                ax, az = wall['start']
                bx, bz = wall['end']
                dx, dz = bx - ax, bz - az
                span = math.hypot(dx, dz)
                alignment = abs((door_end[0] - door_start[0]) * dx + (door_end[1] - door_start[1]) * dz) / (door_width * span)
                along = max(0, min(span, ((center[0] - ax) * dx + (center[1] - az) * dz) / span))
                distance = math.hypot(center[0] - ax - dx * along / span, center[1] - az - dz * along / span)
                candidate = (distance + 5 * (1 - min(1, alignment)), index, along)
                if nearest is None or candidate < nearest:
                    nearest = candidate
            _, wall, offset = nearest
            area = footprint_area(outline)
            # shortcut: size the circulation from the footprint and floor count until floor plans exist.
            elevators = min(8, max(1, math.ceil(area * floors / 8000))) if floors >= 5 else 0
            stairs = 0 if floors == 1 else 1 + int(area >= 1500 or elevators >= 4)
            profiles[ident] = {
                'shape': footprint_shape(outline, width, depth, area),
                'width': round(width, 3), 'depth': round(depth, 3), 'height': round(height, 3),
                'aspectRatio': round(max(width, depth) / min(width, depth), 3),
                'origin': placement['position'], 'yaw': yaw, 'outline': outline,
                'floorCount': floors, 'floorHeight': round((top - bottom) / floors, 4), 'facadeBase': round(bottom - oy, 3),
                'elevatorCount': elevators, 'staircaseCount': stairs,
                'windowSlots': floors * sum(wall['windowColumns'] for wall in facades),
                'facades': facades,
                'entrance': {
                    'wallIndex': wall, 'offset': round(offset, 3), 'center': center,
                    'base': round(p[1] - oy, 3), 'width': round(door_width, 3), 'height': round(p[4] - p[1], 3),
                },
            }
    return profiles


if __name__ == '__main__':
    city = json.loads((DATA / 'city.json').read_text())
    profiles = prepare_profiles(city)
    with (DATA / 'building-profiles.json').open('w') as output:
        output.write('{\n' + ',\n'.join(json.dumps(key) + ':' + json.dumps(value, separators=(',', ':'))
                                       for key, value in sorted(profiles.items())) + '\n}\n')
    print(f'{len(profiles)} building profiles')
