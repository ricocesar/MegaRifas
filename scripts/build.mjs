import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import * as esbuild from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const publicDir = path.join(rootDir, 'public');

execSync('node --check server.js', { cwd: rootDir, stdio: 'inherit' });
execSync('npx tsc --noEmit', { cwd: rootDir, stdio: 'inherit' });

fs.mkdirSync(publicDir, { recursive: true });

await esbuild.build({
  entryPoints: [path.join(rootDir, 'src', 'main.ts')],
  bundle: true,
  minify: true,
  format: 'esm',
  target: ['es2020'],
  outfile: path.join(publicDir, 'app.bundle.js'),
  sourcemap: false,
});

fs.copyFileSync(
  path.join(rootDir, 'index.html'),
  path.join(publicDir, 'index.html')
);

console.log('Build complete: public/index.html & public/app.bundle.js generated.');
