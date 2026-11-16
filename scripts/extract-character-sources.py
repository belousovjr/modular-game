"""Prepare only required CC0 source files from four fresh official Standard ZIP downloads.
Usage: python3 scripts/extract-character-sources.py base.zip outfits.zip ual1.zip ual2.zip output_dir
"""
import json
from pathlib import Path
import sys
from zipfile import ZipFile

if len(sys.argv) != 6:
    raise SystemExit(__doc__)
base_zip, outfit_zip, library1_zip, library2_zip, destination = sys.argv[1:]
output = Path(destination)

def extract(archive, folder, names, prefix):
    target = output / folder
    target.mkdir(parents=True, exist_ok=True)
    with ZipFile(archive) as source:
        for name in names:
            matches = [n for n in source.namelist() if prefix in n and n.endswith('/' + name)]
            if len(matches) != 1:
                raise ValueError(f'Missing or ambiguous source: {name}')
            if source.getinfo(matches[0]).file_size > 32 * 1024 * 1024:
                raise ValueError('Source file exceeds preparation budget')
            (target / name).write_bytes(source.read(matches[0]))

extract(base_zip, 'base', ['Superhero_Male_FullBody.gltf', 'Superhero_Male_FullBody.bin', 'T_Hair_1_BaseColor.png', 'T_Eye_Brown.png', 'T_Superhero_Male_Dark.png', 'T_Superhero_Male_Normal.png'], '/Base Characters/Godot - UE/')
extract(base_zip, 'base', ['Hair_SimpleParted.gltf', 'Hair_SimpleParted.bin'], '/Hairstyles/Rigged to Head Bone/glTF (Godot -Unreal)/')
extract(outfit_zip, 'model', ['Male_Peasant.gltf', 'Male_Peasant.bin', 'T_Peasant_BaseColor.png', 'T_Peasant_Normal.png', 'T_Regular_Male_Dark_BaseColor.png', 'T_Regular_Male_Normal.png'], '/Exports/glTF (Godot-Unreal)/Outfits/')
for archive, number in [(library1_zip, 1), (library2_zip, 2)]:
    folder = output
    with ZipFile(archive) as source:
        name = next(n for n in source.namelist() if n.endswith(f'/Unreal-Godot/UAL{number}_Standard.glb'))
        prefix = 'universal-animation-library-' if number == 1 else 'universal-animation-library-2-'
        folder.mkdir(parents=True, exist_ok=True)
        (folder / f'{prefix}UAL{number}_Standard.glb').write_bytes(source.read(name))
# Retain the author's albedo/normal slots; omit unused roughness/eye/hair normal maps.
for folder, name in [('model', 'Male_Peasant'), ('base', 'Superhero_Male_FullBody'), ('base', 'Hair_SimpleParted')]:
    path = output / folder / (name + '.gltf')
    data = json.loads(path.read_text())
    used = set()
    for material in data['materials']:
        pbr = material.get('pbrMetallicRoughness', {})
        pbr.pop('metallicRoughnessTexture', None)
        pbr['metallicFactor'], pbr['roughnessFactor'] = 0, .75
        material.pop('occlusionTexture', None)
        if 'Hair' in material.get('name', '') or 'Eyes' in material.get('name', ''):
            material.pop('normalTexture', None)
        for slot in [pbr.get('baseColorTexture'), material.get('normalTexture')]:
            if slot:
                used.add(slot['index'])
    for i, texture in enumerate(data.get('textures', [])):
        if i not in used:
            texture['source'] = data['textures'][min(used)]['source']
    images = {t['source'] for t in data.get('textures', [])}
    for i, image in enumerate(data.get('images', [])):
        if i not in images:
            image['uri'] = data['images'][min(images)]['uri']
    path.write_text(json.dumps(data))
