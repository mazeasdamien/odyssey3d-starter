import { defineConfig } from 'vite';

// The page reaches the LeiaSR bridge same-origin through /sr-bridge (no CORS, no mixed content).
// The dev server only listens on this machine.
export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5173,
    watch: { ignored: ['**/sr-bridge/**', '**/tools/**'] },
    proxy: {
      '/sr-bridge': {
        target: 'http://127.0.0.1:5033',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/sr-bridge/, ''),
      },
    },
  },
});
