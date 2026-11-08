import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildContextReport,
  redactArgs,
} from '../sidecars/context-inspector/lib/contextAggregator.mjs';
import { LanguageServerClient } from '../sidecars/context-inspector/lib/lsClient.mjs';
import { createInspectorApp } from '../sidecars/context-inspector/main.mjs';

const SCRATCH_DIR =
  '/Users/wenwei/.gemini/antigravity/brain/53983d06-8d1b-4cb9-9ebf-276b3a412f7c/scratch';
const CONVERSATION_ID = '53983d06-8d1b-4cb9-9ebf-276b3a412f7c';

function loadFixture(name) {
  return JSON.parse(readFileSync(join(SCRATCH_DIR, `${name}.json`), 'utf-8'));
}

test('buildContextReport decomposes live Language Server payloads with exact token reconciliation', () => {
  const tokenBaseRes = loadFixture('GetTokenBase');
  const generatorMetaRes = loadFixture('GetCascadeTrajectoryGeneratorMetadata');
  const executorMetaRes = loadFixture('GetCascadeTrajectoryExecutorMetadatas');
  const mcpStatesRes = loadFixture('GetMcpServerStates');

  const report = buildContextReport({
    conversationId: CONVERSATION_ID,
    workspaceUris: ['file:///Users/wenwei/Documents/antigravity/usage'],
    tokenBaseRes,
    generatorMetaRes,
    executorMetaRes,
    mcpStatesRes,
  });

  // 1. Summary & Model checks
  assert.equal(report.hasLiveConversation, true);
  assert.equal(report.model.displayName, 'Gemini 4 Argon (Medium)');
  assert.equal(report.summary.estimatedTokensUsed, 183261);
  assert.equal(report.summary.maxContextTokens, 256000);
  assert.equal(report.summary.freeTokens, 256000 - 183261);
  assert.equal(report.summary.turnCount, 43);
  assert.equal(report.summary.stepCount, 120);

  // 2. Category breakdown sums to exact estimatedTokensUsed (183,261)
  const categorySum = report.categories.reduce((acc, c) => acc + c.tokens, 0);
  assert.equal(
    categorySum,
    report.summary.estimatedTokensUsed,
    'Sum of decomposed categories must equal total estimatedTokensUsed'
  );

  const byId = Object.fromEntries(report.categories.map((c) => [c.id, c]));
  assert.equal(byId.messages.tokens, 162876);
  assert.equal(byId.system_tools.tokens, 6163);
  assert.equal(byId.mcp_tools.tokens, 1129);
  assert.equal(byId.system_prompt.tokens, 7341);
  assert.equal(byId.skills.tokens, 4795);
  assert.equal(byId.mcp_instructions.tokens, 716);
  assert.equal(byId.rules.tokens, 241);

  // 3. Customization & Rules Budgets
  assert.equal(report.budgets.customization.max, 20000);
  assert.equal(report.budgets.customization.used, 4734);
  assert.equal(report.budgets.customization.remaining, 15266);
  assert.equal(report.budgets.rules.max, 20000);
  assert.equal(report.budgets.rules.used, 139);

  // 4. Eager vs Lazy MCP Servers
  const mcpByName = Object.fromEntries(
    report.details.mcpServers.map((s) => [s.serverName, s])
  );
  assert.equal(mcpByName['gemini-api_gemini-api-docs'].mode, 'EAGER');
  assert.equal(mcpByName['gemini-api_gemini-api-docs'].activeSchemaTokens, 1129);
  assert.equal(mcpByName['chrome-devtools-mcp'].mode, 'LAZY');
  assert.equal(mcpByName['chrome-devtools-mcp'].promptIndexTokens, 171);
  assert.ok(
    mcpByName['chrome-devtools-mcp'].deferredTokens > 2000,
    'Lazy MCP server should report deferred full JSON schema tokens'
  );
  assert.ok(report.deferred.mcpToolsTokens > 7000);

  // 5. Security: StitchMCP API key is redacted
  const stitchArgs = mcpByName['StitchMCP'].args.join(' ');
  assert.ok(
    !stitchArgs.includes('AQ.Ab8RN6'),
    'API key in StitchMCP args must be redacted'
  );
  assert.ok(stitchArgs.includes('<REDACTED>'));

  // 6. Skills inventory includes both user/plugin and builtin skills
  assert.equal(report.details.skills.length, 26);
  const chromeExtSkill = report.details.skills.find(
    (s) => s.name === 'chrome-extensions'
  );
  assert.equal(chromeExtSkill.activeTokens, 324);
  assert.equal(chromeExtSkill.pluginName, 'modern-web-guidance-plugin');
});

test('redactArgs masks sensitive headers and tokens', () => {
  const input = [
    'mcp-remote',
    'https://stitch.googleapis.com/mcp',
    '--header',
    'X-Goog-Api-Key: AQ.SecretValue123',
    '--token=my_secret_token',
  ];
  const out = redactArgs(input);
  assert.equal(out[3], 'X-Goog-Api-Key: <REDACTED>');
  assert.equal(out[4], '--token: <REDACTED>');
});

test('Sidecar app serves UI pages and /api/context endpoint', async () => {
  const lsClient = new LanguageServerClient({
    fixturesDir: SCRATCH_DIR,
  });
  const app = await createInspectorApp({ lsClient });

  // GET /
  const indexRes = await app.invokePage('/');
  assert.equal(indexRes.status, 200);
  assert.ok(indexRes.body.includes('Context Inspector'));
  assert.ok(indexRes.body.includes('interpolate-size: allow-keywords'));

  // GET /app.js
  const appJsRes = await app.invokePage('/app.js');
  assert.equal(appJsRes.status, 200);
  assert.ok(appJsRes.body.includes('renderReport'));

  // GET /preload.js
  const preloadRes = await app.invokePage('/preload.js');
  assert.equal(preloadRes.status, 200);
  assert.ok(preloadRes.body.includes('window.sidecar'));

  // POST /api/context
  const ctxJson = await app.invokeApi('/api/context', {
    conversationId: CONVERSATION_ID,
    workspaceUris: ['file:///Users/wenwei/Documents/antigravity/usage'],
  });
  assert.equal(ctxJson.summary.estimatedTokensUsed, 183261);
  assert.equal(ctxJson.diagnostics.errors.length, 0);
});

test('Marketplace plugin manifest, logo asset, and companion skill are valid', () => {
  const projectRoot = join(
    '/Users/wenwei/Documents/antigravity/usage'
  );
  const manifest = JSON.parse(
    readFileSync(join(projectRoot, 'plugin.json'), 'utf-8')
  );
  assert.equal(manifest.name, 'context-inspector');
  assert.equal(manifest.displayName, 'Context Inspector');
  assert.equal(manifest.logo, 'assets/logo.svg');
  assert.equal(typeof manifest.author?.name, 'string');
  assert.ok(manifest.repository?.url?.startsWith('https://'));
  assert.equal(manifest.suggestedPrompts.length, 3);

  const logoSvg = readFileSync(join(projectRoot, manifest.logo), 'utf-8');
  assert.ok(logoSvg.includes('viewBox="0 0 128 128"'));

  const skillMd = readFileSync(
    join(projectRoot, 'skills', 'context-inspector', 'SKILL.md'),
    'utf-8'
  );
  assert.ok(skillMd.includes('name: context-inspector'));
  assert.ok(
    skillMd.includes('sidecar://context-inspector/context-inspector/')
  );
});
