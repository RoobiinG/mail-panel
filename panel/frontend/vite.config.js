import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // Entwicklung: API-Aufrufe an das lokal laufende Backend durchreichen
    proxy: { '/api': 'http://localhost:3002' },
  },
  build: { outDir: 'dist' },
});
