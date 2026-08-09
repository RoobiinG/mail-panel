import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';

// read version.json (locally it's in ../../, in Docker it's in ./)
const localPath = path.resolve(__dirname, '../../version.json');
const dockerPath = path.resolve(__dirname, './version.json');
const versionFile = fs.existsSync(localPath) ? localPath : dockerPath;
let appVersion = { version: 'unknown', build: 0 };
if (fs.existsSync(versionFile)) {
  appVersion = JSON.parse(fs.readFileSync(versionFile, 'utf-8'));
}

export default defineConfig({
  plugins: [react()],
  server: {
    // Entwicklung: API-Aufrufe an das lokal laufende Backend durchreichen
    proxy: { '/api': 'http://localhost:3002' },
  },
  build: { outDir: 'dist' },
  define: {
    __APP_VERSION__: JSON.stringify(appVersion.version),
    __APP_BUILD__: JSON.stringify(appVersion.build),
  }
});
