import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Two builds from one source:
//   default  - a normal static bundle, served over http(s), PWA-installable
//   offline  - everything inlined into one .html file you can double-click
//
// The second exists because `file://` blocks ES modules via CORS, so a normal
// multi-file bundle simply will not run when opened from disk.
export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === 'offline' ? [viteSingleFile()] : [])],
  build: {
    outDir: mode === 'offline' ? 'dist-offline' : 'dist',
    target: 'es2022',
    ...(mode === 'offline' ? { assetsInlineLimit: 100_000_000, cssCodeSplit: false } : {}),
  },
  server: { port: 5173, proxy: { '/api': 'http://localhost:3000' } },
}));
