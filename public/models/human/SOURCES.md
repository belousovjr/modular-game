# Optimized humanoid — provenance and animation coverage

The original Quaternius model and animation inputs were downloaded separately from the author's official free Standard archives on **2026-11-16**. No model, animation, texture, license file or build script from the neighboring chicago-test project was used as an input.

## Author sources (Quaternius, CC0 1.0)

- [Modular Character Outfits — Fantasy](https://quaternius.com/packs/modularcharacteroutfitsfantasy.html), official [download](https://quaternius.itch.io/modular-character-outfits-fantasy): `Male_Peasant.gltf` + `.bin`, albedo and normal textures from `Exports/glTF (Godot-Unreal)/Outfits`. This is a plain clothed body, without weapons/armor or gameplay rules. Standard upload ID: 16289385.
- [Universal Base Characters](https://quaternius.com/packs/universalbasecharacters.html), official [download](https://quaternius.itch.io/universal-base-characters): the anatomically modeled head/neck and eyebrows/eyes from `Superhero_Male_FullBody`, plus `Hair_SimpleParted` from `Hairstyles/Rigged to Head Bone`. The superhero torso is excluded. Standard upload ID: 15861669.
- [Universal Animation Library](https://quaternius.itch.io/universal-animation-library): `Unreal-Godot/UAL1_Standard.glb`, the in-place variant, 43 verified clips. Standard upload ID: 17958403.
- [Universal Animation Library 2](https://quaternius.itch.io/universal-animation-library-2): `Unreal-Godot/UAL2_Standard.glb`, 43 verified clips. Standard upload ID: 17958478.

Original license texts: LICENSE-base.txt, LICENSE-outfit.txt, LICENSE-animation-1.txt, LICENSE-animation-2.txt. All selected Standard assets are CC0. No paid purchase was made.

## Animation library versus runtime contents

The author advertises **120+** and **130+** animations for the full libraries. **Those full counts are not the free/runtime contents.** The Standard files actually inspected here contain 43 + 43 clips, including a shared T-pose. Full Pro/Source editions are separate paid downloads at the author pages. `manifest.json` records the actual verified clip names.

Verified free categories include locomotion, crouching, swimming, sitting/talking, death/hit reactions, melee/sword/shield attacks, pistols, simple spellcasting, interaction/pickup, crafting/fixing, planting/harvesting/watering, tree chopping, climbing/sliding and emotes. This is a substantial MMORPG foundation, not a claim to cover every future mount, profession or class-specific skill. More specialized actions still require selecting and integrating the relevant clips/mechanics.

The original seven locomotion/jump clips in character.glb are: **Idle_Loop, Walk_Loop, Jog_Fwd_Loop, Sprint_Loop, Jump_Start, Jump_Loop, Jump_Land**. Other clips are catalogued and ready for the same offline retargeting process; they are not eagerly loaded in the browser. The locomotion rig is a single 65-joint Humanoid skeleton. Animations are retargeted with bind-pose correction rather than assuming that matching bone names imply matching bind transforms. In-place animation never drives authority position.

## Render budget and derivative changes

- 5,970 triangles, one skinned mesh, one primitive/material: one main-pass draw per avatar, plus normal shadow passes.
- 65 joints, four influences per vertex, shared source geometry/material/textures across avatar instances; each instance has its own skeleton/animation state.
- GLB: about 0.85 MB; exact SHA-256 is in manifest.json.
- One 1024² albedo atlas and one 512² normal atlas, about 6.7 MiB decoded RGBA including mipmaps, shared per scene.
- The original outfit parts are joined; unneeded source geometry/material maps are removed. Meshoptimizer reduces indices while preserving skin attributes and the head silhouette. Head/neck are extracted from the full base, with shoulder influences removed at the covered collar seam. A dark-brown hair tint is baked into the atlas. Periodic eye UVs are baked before atlas packing; gutters preserve seams under mipmapping.
- Clips are baked at 30 Hz with normalized quaternion tracks, then redundant keys are removed. Babylon plays and blends the prepared skeletal clips; there is no runtime retargeting, remote decoder or external asset CDN.

## Rebuild from fresh official downloads

```sh
python3 scripts/extract-character-sources.py base.zip outfits.zip ual1.zip ual2.zip /tmp/character-source
node --max-old-space-size=512 scripts/prepare-character.mjs /tmp/character-source
```

Use the Standard archives named above. The extraction helper copies only the required files and removes unused material image references before NodeIO parsing. Preparation dependencies are development-only. The game only needs the checked-in GLB, native Babylon glTF loader, and browser image codecs. No access to another game repository is required.

Runtime also includes Jump_Start, Jump_Loop and Jump_Land from the same freshly downloaded official UAL1 Standard archive. All seven clips use the same 65-joint rig.

476 of 910 bone tracks are removed because the same bone/property stays at bind pose in every runtime clip. Tracks are retained across every clip whenever any clip changes that property, preserving crossfade resets. This reduces per-avatar animation evaluation without changing the mesh or poses.


## Vehicle interaction extension (2026-11-17)

Runtime now also contains **Driving_Loop** from the same CC0 Quaternius UAL1 Standard archive, and **Car_Enter / Car_Exit**, retargeted from the actual **Mixamo Entering Car / Exiting Car** clips. The latter are governed by **Adobe Mixamo terms, not CC0**; [Adobe's FAQ](https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html) permits use in video games. This combined runtime asset must not be treated as an all-CC0 animation library or redistributed as a standalone Mixamo animation pack.

The two input FBXs were obtained from the public [Linzhan/Mixamo-Animations-Characters dataset](https://huggingface.co/datasets/Linzhan/Mixamo-Animations-Characters), whose card labels them `adobe-mixamo-terms`. Exact URLs/SHA-256 values are in manifest.vehicleAnimations. Original FBXs remain outside the repository; only the retargeted game runtime clips are embedded. No Mixamo character mesh is included.

Prepare the Quaternius base with prepare-character.mjs, then:

```sh
node --max-old-space-size=512 scripts/prepare-car-animations.mjs /path/to/mixamo-fbx-directory
```

The directory contains Entering_Car.fbx and Exiting_Car.fbx. Assimp (development-only) converts FBX to glTF. The pipeline maps Mixamo humanoid joints to the outfit rig with bind-pose correction, removes duplicated Assimp FBX pivot helper transforms for animation evaluation, retains limb proportions and bakes at 30 Hz. Input playback is 1.5×; durations are approximately 3.644/3.867 seconds. Source horizontal root travel is replaced by authority-owned boarding/exiting movement; vertical pelvis motion is fitted between the correct standing/driving positions in the outfit's **local Z-up skeletal parent**, not assumed local Y. Car driving itself never depends on animation root motion.

These are actual car-specific entry/exit motions, not the generic Sitting_Enter/Sitting_Exit clips used during the first unfinished attempt. Constant reset tracks across all ten runtime clips prevent stale hand poses. Geometry/materials/textures/65 joints remain shared; exact runtime GLB hash is in manifest.json.

The final 12% of Car_Enter is smoothly fitted to the first Driving_Loop pose (all local joint rotations and pelvis translation). This keeps the held final pose and the driving crossfade consistent without a transient torso/head rise. The asset regression checks the exact endpoint and late head height.


### Crawling escape clip

`Crawl_Loop` is retargeted from Mixamo `Crawling.fbx`, downloaded from [the same public Adobe-terms dataset](https://huggingface.co/datasets/Linzhan/Mixamo-Animations-Characters/resolve/main/animation/Crawling.fbx) as the car clips. It is **not** a Quaternius Standard/CC0 clip; the user accepted any compatible crawling animation. The inspected free Quaternius Standard library does not contain crawling. Source hash/duration/licence are in manifest.vehicleAnimations. `prepare-car-animations.mjs` now takes Crawling.fbx alongside the two car FBXs, removes horizontal root motion and compensates the target proportions to keep hands above ground. Runtime now contains eleven clips; GLB remains below 1400 KiB, with the same mesh, textures and rig.

Flight and swimming extension. After preparing the human and its vehicle animations, run `node scripts/prepare-locomotion-animations.mjs /path/to/UAL1_Standard.glb`. The script retargets `Swim_Fwd_Loop` and `Swim_Idle_Loop` from Quaternius Universal Animation Library Standard (CC0); the archive and SHA-256 are in the manifest. Jog and sprint use the distinct existing Quaternius clips. The three flight clips are original poses authored on the project rig. The output remains a single skinned mesh with the same textures and joints.
