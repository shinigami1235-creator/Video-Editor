import { defineConfig } from 'vite';

export default defineConfig({
  clearScreen: false,
  // Rust build files change while the app compiles, so Vite must not watch them.
  server: {
    port: 5173,
    strictPort: true,
    // tests run with VE_TEST=1 so edits made during a run do not reload the page
    watch: process.env.VE_TEST ? null : { ignored: ['**/src-tauri/**', '**/tests/**'] },
    hmr: process.env.VE_TEST ? false : undefined,
    // used only by the browser tests; the desktop app talks to Rust directly
    proxy: {
      '/api': 'http://127.0.0.1:5174',
      '/file': 'http://127.0.0.1:5174',
    },
  },
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  worker: { format: 'es' },
});
