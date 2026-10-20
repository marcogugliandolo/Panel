import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        // Las librerías cambian poco: en su propio fichero, el navegador las mantiene en caché entre versiones.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (/[\\/](recharts|d3-[^\\/]+|victory-vendor|@reduxjs|redux|react-redux|reselect|immer|decimal\.js-light|es-toolkit|eventemitter3)[\\/]/.test(id)) {
            return 'charts';
          }
          return 'vendor';
        },
      },
    },
  },
});
