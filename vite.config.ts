import { devApi } from './scripts/dev-api.ts';
import { cityDetailAssets } from './scripts/city-detail-assets.ts';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), ['NEON_AUTH_BASE_URL', 'VITE_NEON_AUTH_URL', 'GAME_PORT', 'PORT']);
  const apiTarget = new URL(`http://127.0.0.1:${env.PORT || env.GAME_PORT || '5177'}`);
  return {
    define: { 'import.meta.env.VITE_NEON_AUTH_URL': JSON.stringify(env.VITE_NEON_AUTH_URL || env.NEON_AUTH_BASE_URL || '') },
    plugins: [devApi(apiTarget), cityDetailAssets()],
    server: { proxy: { '/api': apiTarget.href } },
  };
});
