# City color textures

Copied from sibling chicago-test/public/textures/chicago with user authorization.
Only the six color families asphalt/concrete/brick/roof/grass/metal are used.
Files *-128.webp are upstream LOD1; *-32.webp are upstream LOD2, copied unchanged.
Upstream sources and derived textures declare CC0-1.0; see UPSTREAM-SOURCES.md and upstream-manifest.json for sources and archive hashes. No photographs/maps/character assets were copied.

Near geometry LOD uses 128², middle LOD 32², far LOD reuses the same 32² texture with mipmaps. All texture files use runtime mipmaps and trilinear sampling. No normal/AO/specular maps or high resolution originals are loaded. Six pairs plus two building atlases cost at most about 907 KiB decoded RGBA with full mip chains (excludes driver overhead).

Building atlases are reproducible code-native SVG compositions: run `node scripts/build-building-atlas.mjs`. Each SVG embeds the existing CC0 roof/brick/metal/concrete WebP; no external references or raster editing dependency. The 256²/64² atlases keep a 2×2 layout (roof/plain wall/marked wall/base) and 1/32-cell UV gutters. The facade marker is 75% wide, 18% tall, centered at 55% of building height; metadata is checked against the world template. All building LODs share these textures. All bodies select the same wall tile. Geometry normalizes vertical V by local Y on all four walls, rather than inheriting the opposite-face flips of Babylon box UVs. Marker height therefore matches real protrusions on both sides.


Current runtime uses only six *-128.webp files, shared across all geometry LODs (about 512 KiB RGBA including mipmaps). SurfaceScale selects density in metres, one repeat per 2 m; hardware mipmaps select smaller levels from the projected footprint. The small WebP banks and SVG atlases above remain offline source/reference artifacts and are not fetched. Building UV quadrants classify faces and the facade patch; original brick/roof/concrete/metal samplers provide the actual repeating detail, avoiding mip bleed between atlas cells.
