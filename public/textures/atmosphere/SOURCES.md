# Lunar texture

[NASA Scientific Visualization Studio CGI Moon Kit](https://svs.gsfc.nasa.gov/4720/): LRO LROC colour map, NASA/GSFC/Arizona State University, public-domain data. Official 1024×512 JPEG reduced to 512×256 WebP. The public HTTP download was used because the HTTPS endpoint did not supply a verifiable certificate chain in this environment. No accounts/credentials used. Exact source URL/hash in manifest.json.

Pinned locally; no runtime map requests. Rebuild with `node scripts/prepare-atmosphere.mjs <input-directory>` containing moon.jpg. The former USGS aerial backdrop was removed at the user's request; below the horizon the shader uses the same colour as scene fog. The upper sky gradient, sun, Moon and stars remain emissive; no normal/AO map is claimed for the sky. Existing world material maps and real shadows remain separate.
