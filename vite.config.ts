import fs from 'fs';
import path from 'path';
import {defineConfig} from 'vite';

const wwwRoot = path.resolve(__dirname, 'www');
const distOut = path.resolve(__dirname, 'dist');

function copyStaticWwwAssets() {
  return {
    name: 'copy-static-www-assets',
    closeBundle() {
      const staticDirs = ['js', 'css', 'images'];
      for (const dir of staticDirs) {
        const src = path.join(wwwRoot, dir);
        const dest = path.join(distOut, dir);
        if (fs.existsSync(src)) {
          fs.cpSync(src, dest, {recursive: true});
        }
      }
      const staticFiles = ['overlay.html', '404.html', 'realtime.txt'];
      for (const file of staticFiles) {
        const src = path.join(wwwRoot, file);
        const dest = path.join(distOut, file);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, dest);
        }
      }
    },
  };
}

export default defineConfig(() => {
  return {
    root: wwwRoot,
    publicDir: false,
    plugins: [copyStaticWwwAssets()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      outDir: distOut,
      emptyOutDir: true,
    },
    server: {
      port: 3000,
      host: '0.0.0.0',
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
