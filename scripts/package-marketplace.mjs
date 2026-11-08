import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const distDir = join(projectRoot, 'dist');

const manifest = JSON.parse(
  readFileSync(join(projectRoot, 'plugin.json'), 'utf-8')
);
const pluginName = manifest.name || 'context-inspector';
const zipFileName = `${pluginName}.zip`;
const zipPath = join(distDir, zipFileName);

mkdirSync(distDir, { recursive: true });
rmSync(zipPath, { force: true });

// Package only the clean plugin files required by Antigravity Marketplace
const includePaths = [
  'plugin.json',
  'README.md',
  'assets',
  'skills',
  'sidecars',
];

execFileSync('zip', ['-r', '-q', zipPath, ...includePaths], {
  cwd: projectRoot,
});

const zipBuffer = readFileSync(zipPath);
const sha256 = createHash('sha256').update(zipBuffer).digest('hex');

const baseUrl =
  process.env.MARKETPLACE_BASE_URL ||
  `https://github.com/digitsoul/antigravity-context-inspector/releases/download/v${manifest.version}`;

const catalogEntry = {
  name: manifest.name,
  displayName: manifest.displayName,
  version: manifest.version,
  description: manifest.description,
  logo: `${baseUrl}/logo.svg`,
  suggestedPrompts: manifest.suggestedPrompts,
  author: manifest.author,
  homepage: manifest.homepage,
  repository:
    typeof manifest.repository === 'object'
      ? manifest.repository.url
      : manifest.repository,
  license: 'MIT',
  keywords: [
    'context',
    'inspector',
    'tokens',
    'optimization',
    'mcp',
    'skills',
    'sidecar',
  ],
  source: {
    type: 'archive',
    url: `${baseUrl}/${zipFileName}`,
    sha256,
  },
};

const marketplaceCatalog = {
  name: 'custom-antigravity-plugins',
  description: 'Custom Antigravity plugins marketplace catalog.',
  plugins: [catalogEntry],
};

const catalogPath = join(distDir, 'marketplace.json');
writeFileSync(catalogPath, JSON.stringify(marketplaceCatalog, null, 2) + '\n');

console.log(`✅ Built Marketplace archive: ${zipPath}`);
console.log(`🔒 SHA-256: ${sha256}`);
console.log(`📄 Generated catalog manifest: ${catalogPath}`);
