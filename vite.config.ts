import { cityDetailAssets } from './scripts/city-detail-assets.ts';
import { defineConfig, loadEnv } from 'vite';
import { createCharactersHandler } from './api/characters.ts';
import { createDbHealth } from './api/db-health.ts';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), ['DATABASE_URL', 'NEON_AUTH_', 'VITE_NEON_AUTH_URL']);
  const health = createDbHealth(env.DATABASE_URL);
  const characters = createCharactersHandler(env);
  return {
    define: { 'import.meta.env.VITE_NEON_AUTH_URL': JSON.stringify(env.VITE_NEON_AUTH_URL || env.NEON_AUTH_BASE_URL || '') },
    plugins: [cityDetailAssets(), {
      name: 'db-health',
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const path = request.url?.split('?')[0];
          if (path === '/api/db-health') void health(request, response);
          else if (path === '/api/characters') void characters(request, response);
          else next();
        });
      },
    }],
  };
});
