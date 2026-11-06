import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// `/api/*` is forwarded to the wagering API with the prefix removed, so the
// browser only talks to the dev server and CORS is not needed.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  const target = env.VITE_API_URL || 'http://localhost:3000';
  const proxy = {
    '/api': {
      target,
      changeOrigin: true,
      rewrite: (path: string) => path.replace(/^\/api/, ''),
    },
  };

  return {
    plugins: [react()],
    server: { port: 5173, strictPort: true, proxy },
    preview: { port: 5173, strictPort: true, proxy },
  };
});
