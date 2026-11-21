import { defineConfig, loadEnv } from 'vite';
import { createDbHealth } from './api/db-health.ts';

export default defineConfig(({ mode }) => {
  const { DATABASE_URL } = loadEnv(mode, process.cwd(), 'DATABASE_URL');
  const health = createDbHealth(DATABASE_URL);
  return {
    plugins: [{
      name: 'db-health',
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url?.split('?')[0] !== '/api/db-health') return next();
          void health(request, response);
        });
      },
    }],
  };
});
