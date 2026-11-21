import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { buildRoadRecipe } from '../src/modules/world/road-recipe.ts';
import { generateCity } from '../src/modules/world-generation/headless.ts';
import { splitStreetAssets } from '../src/modules/world/street-assets.ts';
import district from '../src/modules/world/data/downtown/district.json' with { type: 'json' };
import { splitCityDetails } from '../src/modules/world/detail-assets.ts';

const source = fileURLToPath(new URL('../src/modules/world/data/downtown/city.json', import.meta.url));
const virtual = '\0city-startup-data';

export function cityDetailAssets(): Plugin {
  const assets = new Map<string, string>();
  function prepare() {
    assets.clear();
    const city = generateCity(JSON.parse(readFileSync(source, 'utf8')));
    function emit(kind: string, index: number, value: object) {
      const data = JSON.stringify(value);
      const hash = createHash('sha256').update(data).digest('hex').slice(0, 16);
      const path = `${kind}/${index}-${hash}.json`;
      assets.set(path, data);
      return path;
    }
    return splitStreetAssets(
      splitCityDetails(city, (index, details) => emit('world-details', index, details)),
      district.tileSize, (index, content) => emit('world-streets', index, content),
    );
  }
  return {
    name: 'city-detail-assets',
    enforce: 'pre',
    resolveId(id) { if (id === './data/downtown/city.json') return virtual; },
    load(id) {
      if (id !== virtual) return;
      this.addWatchFile(source);
      const city = prepare();
      if (this.environment.mode === 'build') {
        for (const [fileName, source] of assets) this.emitFile({ type: 'asset', fileName, source });
      }
      const recipes = city.chunks.flatMap((chunk, chunkIndex) => chunk.meshes.flatMap((mesh, meshIndex) => {
        const recipe = buildRoadRecipe(mesh);
        return recipe ? [{ chunkIndex, meshIndex, recipe }] : [];
      }));
      const replaced = new Set(recipes.map(({ chunkIndex, meshIndex }) => `${chunkIndex}/${meshIndex}`));
      const compact = { ...city, chunks: city.chunks.map((chunk, chunkIndex) => ({ ...chunk,
        meshes: chunk.meshes.map((mesh, meshIndex) => replaced.has(`${chunkIndex}/${meshIndex}`) ? null : mesh),
      })) };
      return `import { generateRoad } from "/src/modules/world/road-recipe.ts";
const city = ${JSON.stringify(compact)};
for (const { chunkIndex, meshIndex, recipe } of ${JSON.stringify(recipes)}) {
  city.chunks[chunkIndex].meshes[meshIndex] = generateRoad(recipe);
}
export default city;`;
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = request.url?.split('?')[0].slice(1);
        if (!path || (!path.startsWith('world-details/') && !path.startsWith('world-streets/'))) return next();
        const json = assets.get(path);
        if (!json) return next();
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(json);
      });
    },
  };
}
