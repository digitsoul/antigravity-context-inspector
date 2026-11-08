import http from 'node:http';
import https from 'node:https';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Connect-RPC client for Antigravity's local LanguageServerService.
 * Uses node:http directly with `agent: false` so loopback calls are never
 * intercepted by external HTTP_PROXY environment variables.
 */
export class LanguageServerClient {
  constructor({
    lsAddress = process.env.ANTIGRAVITY_LS_ADDRESS || '',
    csrfToken = process.env.ANTIGRAVITY_CSRF_TOKEN || '',
    fixturesDir = process.env.ANTIGRAVITY_MOCK_FIXTURES_DIR || '',
    timeoutMs = 8000,
  } = {}) {
    this.lsAddress = lsAddress;
    this.csrfToken = csrfToken;
    this.fixturesDir = fixturesDir;
    this.timeoutMs = timeoutMs;
  }

  get isConfigured() {
    return Boolean(this.lsAddress && this.csrfToken);
  }

  async callRpc(method, payload = {}) {
    if (this.fixturesDir) {
      const fixtureFile = join(this.fixturesDir, `${method}.json`);
      if (existsSync(fixtureFile)) {
        return JSON.parse(readFileSync(fixtureFile, 'utf-8'));
      }
    }

    if (!this.lsAddress) {
      throw new Error(
        `ANTIGRAVITY_LS_ADDRESS is not set and no fixture found for ${method}`
      );
    }

    const rawAddr = this.lsAddress.startsWith('http')
      ? this.lsAddress
      : `http://${this.lsAddress}`;
    const url = new URL(
      `/exa.language_server_pb.LanguageServerService/${method}`,
      rawAddr
    );
    const body = Buffer.from(JSON.stringify(payload), 'utf-8');
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;

    return new Promise((resolve, reject) => {
      const req = transport.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          agent: false,
          timeout: this.timeoutMs,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': body.length,
            ...(this.csrfToken
              ? { 'x-codeium-csrf-token': this.csrfToken }
              : {}),
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf-8');
            if (res.statusCode < 200 || res.statusCode >= 300) {
              reject(
                new Error(
                  `LanguageServerService/${method} HTTP ${res.statusCode}: ${text.slice(0, 300)}`
                )
              );
              return;
            }
            try {
              resolve(text.trim() ? JSON.parse(text) : {});
            } catch (err) {
              reject(
                new Error(
                  `Failed to parse JSON from ${method}: ${err.message}`
                )
              );
            }
          });
        }
      );

      req.on('timeout', () => {
        req.destroy(new Error(`Timeout calling ${method}`));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  async getTokenBase(workspaceUris = []) {
    return this.callRpc('GetTokenBase', { workspaceUris });
  }

  async getGeneratorMetadata(cascadeId, { includeMessages = false } = {}) {
    if (!cascadeId) return { generatorMetadata: [] };
    return this.callRpc('GetCascadeTrajectoryGeneratorMetadata', {
      cascadeId,
      includeMessages,
    });
  }

  async getExecutorMetadatas(cascadeId) {
    if (!cascadeId) return { executorMetadata: [] };
    return this.callRpc('GetCascadeTrajectoryExecutorMetadatas', {
      cascadeId,
    });
  }

  async getMcpServerStates() {
    return this.callRpc('GetMcpServerStates', {});
  }

  async getAllCascadeTrajectories() {
    return this.callRpc('GetAllCascadeTrajectories', {
      excludeSubtrajectories: true,
    });
  }
}
