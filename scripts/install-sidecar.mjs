import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const sidecarDir = join(projectRoot, 'sidecars', 'context-inspector');

const requiredFiles = [
  join(projectRoot, 'plugin.json'),
  join(projectRoot, 'assets', 'logo.svg'),
  join(projectRoot, 'skills', 'context-inspector', 'SKILL.md'),
  join(sidecarDir, 'sidecar.json'),
  join(sidecarDir, 'main.mjs'),
  join(sidecarDir, 'lib', 'lsClient.mjs'),
  join(sidecarDir, 'lib', 'contextAggregator.mjs'),
  join(sidecarDir, 'ui', 'index.html'),
  join(sidecarDir, 'ui', 'app.js'),
];

let allPresent = true;
for (const file of requiredFiles) {
  if (!existsSync(file)) {
    console.error(`[missing] ${file}`);
    allPresent = false;
  }
}

if (!allPresent) {
  process.exit(1);
}

const home = os.homedir();
const globalSidecarsDir = join(home, '.gemini', 'config', 'sidecars', 'context-inspector');
const globalPluginsDir = join(home, '.gemini', 'config', 'plugins', 'context-inspector');

console.log('✅ Context Inspector Sidecar files verified in:', sidecarDir);
console.log('\n--- Install as a Single Antigravity Plugin (Removes Duplicate Global Sidecar) ---');
console.log(`rm -rf "${globalSidecarsDir}" "${globalPluginsDir}"`);
console.log(`mkdir -p "${join(home, '.gemini', 'config', 'plugins')}"`);
console.log(`cp -R "${projectRoot}" "${globalPluginsDir}"`);
