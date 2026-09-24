import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { visualizer } from 'rollup-plugin-visualizer';
import { defineConfig } from 'vite';

const target = 'http://127.0.0.1:4777';

export default defineConfig({
  root: 'web',
  plugins: [
    react(),
    tailwindcss(),
    // ANALYZE=1 npm run build writes web/dist/stats.html (bundle sizes, gzip).
    process.env.ANALYZE ? visualizer({ filename: 'web/dist/stats.html', gzipSize: true, template: 'treemap' }) : null,
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // Figures render in their final state with no motion at runtime (see motion-static.tsx).
      'motion/react': fileURLToPath(new URL('./src/markdown/motion-static.tsx', import.meta.url)),
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target,
        changeOrigin: true,
        // The server only accepts same-origin requests; present them as such.
        configure: (proxy) => {
          proxy.on('proxyReq', (req) => {
            if (req.getHeader('origin')) req.setHeader('origin', target);
          });
        },
      },
    },
  },
});
