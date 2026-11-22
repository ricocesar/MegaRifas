import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const publicDir = path.join(rootDir, 'public');

execSync('node --check server.js', { cwd: rootDir, stdio: 'inherit' });

const indexHtmlPath = path.join(rootDir, 'index.html');
const html = fs.readFileSync(indexHtmlPath, 'utf8');
const match = html.match(/<script>([\s\S]*?)<\/script>/);
if (!match) {
  throw new Error('No inline <script> block found in index.html');
}
new Function(match[1]);

fs.mkdirSync(publicDir, { recursive: true });
fs.copyFileSync(indexHtmlPath, path.join(publicDir, 'index.html'));

console.log('Build complete: public/index.html generated.');
