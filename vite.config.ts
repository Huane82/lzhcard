import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import {defineConfig} from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = fs.existsSync(path.resolve(__dirname, 'lzhcard', 'www'))
  ? path.resolve(__dirname, 'lzhcard')
  : __dirname;
const wwwRoot = path.resolve(projectRoot, 'www');
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
    publicDir: false as const,
    plugins: [copyStaticWwwAssets()],
    resolve: {
      alias: {
        '@': projectRoot,
      },
    },
    build: {
      outDir: distOut,
      emptyOutDir: true,
    },
    server: {
      port: 3000,
      host: '0.0.0.0',
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
