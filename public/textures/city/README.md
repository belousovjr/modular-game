# City color textures

Copied from sibling chicago-test/public/textures/chicago with user authorization.
The six surface families asphalt/concrete/brick/roof/grass/metal supply color and matching OpenGL normal maps.
Files *-512.webp are upstream LOD0 multiplied offline by the matching *-ao.webp (floor(color * AO / 255), encoded as WebP quality 0.82); *-128.webp are upstream LOD1; *-32.webp are upstream LOD2, copied unchanged.
Upstream sources and derived textures declare CC0-1.0; see UPSTREAM-SOURCES.md and upstream-manifest.json for sources and archive hashes. No photographs/maps/character assets were copied.

All geometry LODs share 512² color textures and 512² normal maps, with runtime mipmaps and trilinear sampling. Twelve shared textures cost about 16 MiB decoded RGBA including mipmaps (excludes driver overhead). No separate AO/specular maps are loaded; AO is baked into the 512² colors to preserve the previous palette.

Building atlases are reproducible code-native SVG compositions: run `node scripts/build-building-atlas.mjs`. Each SVG embeds the existing CC0 roof/brick/metal/concrete WebP; no external references or raster editing dependency. The 256²/64² atlases keep a 2×2 layout (roof/plain wall/marked wall/base) and 1/32-cell UV gutters. The facade marker is 75% wide, 18% tall, centered at 55% of building height; metadata is checked against the world template. All building LODs share these textures. All bodies select the same wall tile. Geometry normalizes vertical V by local Y on all four walls, rather than inheriting the opposite-face flips of Babylon box UVs. Marker height therefore matches real protrusions on both sides.


Runtime uses six *-512.webp color files and six *-normal.webp maps, shared across all geometry LODs. SurfaceScale selects density in metres, one repeat per 2 m; hardware mipmaps select smaller levels from the projected footprint. The small WebP banks and SVG atlases above remain offline source/reference artifacts and are not fetched. Building UV quadrants classify faces and the facade patch; original brick/roof/concrete/metal samplers provide the actual repeating detail, avoiding mip bleed between atlas cells.

## Matching normal maps

Six `*-normal.webp` maps (512²) are copied unchanged from the same CC0 chicago-test texture set. They are OpenGL normal maps from the sources listed in upstream-manifest.json; roof is derived from Concrete031, matching its color texture. Runtime uses linear normal data and the same 2 m projection and face selection as the color textures. Twelve shared textures use about 16 MiB decoded RGBA including mipmaps. No extra AO maps or rendering passes are added.

Higher source resolution adds close-up detail through automatic mip selection. Distant projected surfaces still use smaller mip levels, with the same number of texture reads and render passes. These are resident mip chains, not texture streaming; the extra resolution increases memory even when the camera is far away.
