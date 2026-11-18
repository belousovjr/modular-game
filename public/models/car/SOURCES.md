# Compact functional SUV — sources and preparation

- Author: **Awbmecreations**, [Drivable-Free Low Poly Cars](https://awbmecreations.itch.io/drivable-free-low-poly-cars), downloaded 2026-11-17. Free upload `glb.zip` ID 19962261, source `Especial Car_5NL.glb`. The author marks the pack **Royalty Free**; it is **not relabelled CC0**. The author page describes use in games and supplies the free sample with separate doors, wheels, steering wheel and an interior. No neighbouring project's assets were used.
- The inspected source has **11134 triangles**, rather than assuming the 2600–3300 range advertised on the pack page. The prepared runtime model has **3442 triangles**, two PBR materials and one 512² color/AO atlas; exact SHA-256 in manifest.json.
- Geometry is simplified offline with normal/color-aware meshoptimizer constraints. Shared source wheel meshes are cloned before modifying positions/UVs. The wheels, door hinges, steering pivot and interior remain functional. Overall scale is .98 of the authored model; Babylon's glTF coordinate conversion provides the expected left-hand-drive orientation. A 1.8 m person is not scaled down to fit.
- AO: eight hemisphere rays per triangle, 0.9 m range against the closed car geometry, baked into the source-derived color atlas. This is material AO, not a substitute for solar shadow maps. One source palette is sampled at vertices and interpolated in color space; interpolating UVs across unrelated palette regions caused the earlier rainbow streaks and has been removed.
- Relief/facture: existing CC0 metal albedo/normal inputs from `public/textures/city/` (their full upstream provenance is in that directory). Metric UV1 projection drives the native PBR detail map and micro normal; UV0 carries baked color/AO. This gives paint/plastic/rubber visible surface variation without per-part texture copies. `detail.png` packs native Babylon R=detail albedo, G/A=neutral detail normal, B=roughness. Glass remains a separate transparent textured material.

Rebuild with development dependencies only:

```sh
node --max-old-space-size=512 scripts/prepare-car.mjs /path/to/Especial\ Car_5NL.glb
```

The original ZIP/GLB is not republished as a standalone asset pack. These checked-in derivatives are runtime assets of this game project. No paid asset was purchased.

Runtime cabin fit: the body/doors/interior root is 4% taller (Y only), applied after wheel detachment so the tyres keep their shape and physics anchors. Driver guide height is raised by 0.12 m; source mesh/texture budgets are unchanged.

Functional exterior door IDs are assigned only to the source `L Door`/`R Door` nodes. `Interior Door` remains a body/interior node. The builder and runtime reject duplicate exterior door IDs; the original broad suffix match incorrectly gave the interior part the right-door ID.

The broad exterior door faces use the same muted steel-blue paint as the body. Paint contrast from baked occlusion is restrained and the existing 8×8 triangle charts use linear filtering without mipmaps to avoid sampling unrelated charts. Runtime strength of the shared detail texture is reduced. Geometry, pivots and atlas dimensions are preserved.
