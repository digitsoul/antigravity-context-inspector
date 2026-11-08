import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LanguageServerClient } from './lib/lsClient.mjs';
import { buildContextReport } from './lib/contextAggregator.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(__dirname, 'ui');

/**
 * Fallback implementation of Antigravity's `sidecar_sdk` `SidecarApp` & `Response`
 * so this sidecar can also run standalone (`npm start`) or in automated tests
 * outside the Antigravity sidecar launcher.
 */
class StandaloneResponse {
  constructor(body, { status = 200, contentType = 'text/html', headers = {} } = {}) {
    this.body = body;
    this.status = status;
    this.headers = { 'Content-Type': contentType, ...headers };
  }
}

class StandaloneSidecarApp {
  constructor() {
    this._routes = new Map();
    this.lsClient = new LanguageServerClient();
  }

  page(path, handler) {
    this._routes.set(`GET:${path}`, { type: 'page', handler });
    return this;
  }

  api(path, handler, method = 'POST') {
    this._routes.set(`${method.toUpperCase()}:${path}`, { type: 'api', handler });
    return this;
  }

  async invokePage(path) {
    if (path === '/preload.js') {
      return new StandaloneResponse(this._preloadScript(), {
        contentType: 'application/javascript; charset=utf-8',
      });
    }
    const route = this._routes.get(`GET:${path}`);
    if (!route) {
      return new StandaloneResponse('Not Found', { status: 404 });
    }
    const result = await route.handler();
    if (result instanceof StandaloneResponse) return result;
    return new StandaloneResponse(String(result), {
      contentType: path.endsWith('.js')
        ? 'application/javascript; charset=utf-8'
        : 'text/html; charset=utf-8',
    });
  }

  async invokeApi(path, payload = {}, method = 'POST') {
    const route = this._routes.get(`${method.toUpperCase()}:${path}`);
    if (!route) {
      throw new Error(`API route not found: ${method} ${path}`);
    }
    return route.handler(payload);
  }

  _preloadScript() {
    const uiToken = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || 'standalone-dev-token';
    return `(function() {
  var TOKEN = ${JSON.stringify(uiToken)};
  var params = new URLSearchParams(window.location.search);
  var convId = params.get('conversationId') || null;
  var workspaceListeners = [];
  window.addEventListener('message', function(event) {
    if (!event.data) return;
    if (event.data.type === 'theme-change' && event.data.vars) {
      var root = document.documentElement;
      var vars = event.data.vars;
      for (var key in vars) {
        if (Object.prototype.hasOwnProperty.call(vars, key)) {
          root.style.setProperty(key, vars[key]);
        }
      }
    } else if (event.data.type === 'workspace-change' && Array.isArray(event.data.uris)) {
      for (var i = 0; i < workspaceListeners.length; i++) {
        workspaceListeners[i](event.data.uris);
      }
    }
  });
  function sidecarFetch(url, options) {
    options = options || {};
    options.headers = Object.assign({
      'Content-Type': 'application/json',
      'X-Sidecar-Token': TOKEN
    }, options.headers || {});
    return window.fetch(url, options);
  }
  window.sidecar = {
    conversationId: convId,
    fetch: sidecarFetch,
    getWorkspaceUris: function() {
      return sidecarFetch('/_sidecar/get-conversation-metadata', {
        method: 'POST',
        body: JSON.stringify({ conversationId: convId })
      }).then(function(r) { return r.json(); }).then(function(d) { return d.workspaceUris || []; });
    },
    onWorkspaceChange: function(listener) {
      workspaceListeners.push(listener);
      return function() {
        var idx = workspaceListeners.indexOf(listener);
        if (idx !== -1) workspaceListeners.splice(idx, 1);
      };
    },
    agent: {
      sendMessage: function(message, targetConvId) {
        return sidecarFetch('/_sidecar/send-message', {
          method: 'POST',
          body: JSON.stringify({ conversationId: targetConvId || convId, message: message })
        }).then(function(r) { return r.json(); });
      }
    }
  };
})();`;
  }

  run(portOverride) {
    const port =
      portOverride ??
      (process.env.ANTIGRAVITY_SIDECAR_WEB_PORT
        ? parseInt(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT, 10)
        : 43120);

    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
        const method = req.method.toUpperCase();

        if (method === 'GET' && url.pathname === '/preload.js') {
          const js = this._preloadScript();
          res.writeHead(200, {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Content-Length': Buffer.byteLength(js),
          });
          res.end(js);
          return;
        }

        if (method === 'POST' && url.pathname === '/_sidecar/get-conversation-metadata') {
          const out = JSON.stringify({
            workspaceUris: [`file://${process.cwd()}`],
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(out);
          return;
        }

        if (method === 'POST' && url.pathname === '/_sidecar/send-message') {
          const chunks = [];
          for await (const c of req) chunks.push(c);
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
          if (this.lsClient.isConfigured && body.conversationId && body.message) {
            await this.lsClient.callRpc('SendActionToChatPanel', {
              actionType: 'SEND_MESSAGE',
              payload: [body.conversationId, body.message],
            });
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        const route = this._routes.get(`${method}:${url.pathname}`);
        if (!route) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not Found' }));
          return;
        }

        if (route.type === 'page') {
          const result = await route.handler();
          if (result instanceof StandaloneResponse) {
            const buf = Buffer.from(result.body, 'utf-8');
            res.writeHead(result.status, {
              ...result.headers,
              'Content-Length': buf.length,
            });
            res.end(buf);
          } else {
            const contentType = url.pathname.endsWith('.js')
              ? 'application/javascript; charset=utf-8'
              : 'text/html; charset=utf-8';
            const buf = Buffer.from(String(result), 'utf-8');
            res.writeHead(200, {
              'Content-Type': contentType,
              'Content-Length': buf.length,
            });
            res.end(buf);
          }
          return;
        }

        const chunks = [];
        for await (const c of req) chunks.push(c);
        const rawText = Buffer.concat(chunks).toString('utf-8');
        const payload = rawText.trim() ? JSON.parse(rawText) : {};
        const result = await route.handler(payload);
        const jsonBuf = Buffer.from(JSON.stringify(result), 'utf-8');
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': jsonBuf.length,
        });
        res.end(jsonBuf);
      } catch (err) {
        const errBuf = Buffer.from(
          JSON.stringify({ error: err.message || 'Internal Server Error' }),
          'utf-8'
        );
        res.writeHead(500, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': errBuf.length,
        });
        res.end(errBuf);
      }
    });

    return new Promise((resolve) => {
      server.listen(port, '127.0.0.1', () => {
        const address = server.address();
        console.log(
          `[context-inspector] Sidecar UI listening on http://127.0.0.1:${address.port}`
        );
        resolve(server);
      });
    });
  }
}

/**
 * Loads `SidecarApp` and `Response` from Antigravity's native `sidecar_sdk` if
 * available, or falls back to `StandaloneSidecarApp`.
 */
async function loadSdk() {
  try {
    const sdk = await import('sidecar_sdk');
    return {
      SidecarApp: sdk.SidecarApp,
      Response: sdk.Response,
      isNativeSdk: true,
    };
  } catch {
    return {
      SidecarApp: StandaloneSidecarApp,
      Response: StandaloneResponse,
      isNativeSdk: false,
    };
  }
}

/**
 * Resolves the active conversation ID and recent trajectories list.
 */
async function fetchConversationsList(lsClient) {
  try {
    const res = await lsClient.getAllCascadeTrajectories();
    const summaries = res?.trajectorySummaries || {};
    const list = Object.entries(summaries).map(([cascadeId, info]) => ({
      cascadeId,
      summary: info.summary || 'Untitled Conversation',
      stepCount: info.stepCount || 0,
      status: (info.status || '').replace(/^CASCADE_RUN_STATUS_/, ''),
      lastModifiedTime: info.lastModifiedTime || '',
      workspaces: (info.workspaces || [])
        .map((w) => w.workspaceFolderAbsoluteUri)
        .filter(Boolean),
    }));
    list.sort((a, b) =>
      String(b.lastModifiedTime).localeCompare(String(a.lastModifiedTime))
    );
    return list;
  } catch {
    return [];
  }
}

/**
 * Registers all Context Inspector pages and JSON APIs on the SidecarApp instance.
 */
export async function createInspectorApp({ lsClient = new LanguageServerClient() } = {}) {
  const { SidecarApp, Response } = await loadSdk();
  const app = new SidecarApp();

  app.page('/', () => {
    const html = readFileSync(join(UI_DIR, 'index.html'), 'utf-8');
    const js = readFileSync(join(UI_DIR, 'app.js'), 'utf-8');
    const inlinedHtml = html.replace(
      /<script\s+type="module"\s+src="\/app\.js"><\/script>/,
      `<script type="module">\n${js}\n</script>`
    );
    return new Response(inlinedHtml, { contentType: 'text/html; charset=utf-8' });
  });

  app.page('/app.js', () => {
    const js = readFileSync(join(UI_DIR, 'app.js'), 'utf-8');
    return new Response(js, { contentType: 'application/javascript; charset=utf-8' });
  });

  const handleConversations = async () => {
    const conversations = await fetchConversationsList(lsClient);
    return {
      conversations,
      defaultConversationId:
        process.env.ANTIGRAVITY_CONVERSATION_ID ||
        conversations[0]?.cascadeId ||
        '',
    };
  };

  app.api('/api/conversations', handleConversations, 'POST');
  app.api('/api/conversations', handleConversations, 'GET');

  const handleContext = async (body = {}) => {
    let conversationId =
      body.conversationId || process.env.ANTIGRAVITY_CONVERSATION_ID || '';
    let workspaceUris = Array.isArray(body.workspaceUris)
      ? body.workspaceUris
      : typeof body.workspaceUris === 'string' && body.workspaceUris
        ? [body.workspaceUris]
        : [];

    // If no conversationId was passed, try to pick the most recently active trajectory
    if (!conversationId) {
      const recent = await fetchConversationsList(lsClient);
      if (recent.length > 0) {
        conversationId = recent[0].cascadeId;
        if (workspaceUris.length === 0 && recent[0].workspaces.length > 0) {
          workspaceUris = recent[0].workspaces;
        }
      }
    }

    if (workspaceUris.length === 0) {
      workspaceUris = [`file://${process.cwd()}`];
    }

    const [tokenBaseRes, generatorMetaRes, executorMetaRes, mcpStatesRes] =
      await Promise.all([
        lsClient.getTokenBase(workspaceUris).catch((err) => ({
          _error: err.message,
        })),
        lsClient
          .getGeneratorMetadata(conversationId, { includeMessages: false })
          .catch((err) => ({ _error: err.message, generatorMetadata: [] })),
        lsClient
          .getExecutorMetadatas(conversationId)
          .catch((err) => ({ _error: err.message, executorMetadata: [] })),
        lsClient
          .getMcpServerStates()
          .catch((err) => ({ _error: err.message, states: [] })),
      ]);

    const report = buildContextReport({
      conversationId,
      workspaceUris,
      tokenBaseRes,
      generatorMetaRes,
      executorMetaRes,
      mcpStatesRes,
    });

    return {
      ...report,
      diagnostics: {
        lsConnected: Boolean(lsClient.lsAddress || lsClient.fixturesDir),
        errors: [
          tokenBaseRes?._error ? `GetTokenBase: ${tokenBaseRes._error}` : null,
          generatorMetaRes?._error
            ? `GetCascadeTrajectoryGeneratorMetadata: ${generatorMetaRes._error}`
            : null,
          executorMetaRes?._error
            ? `GetCascadeTrajectoryExecutorMetadatas: ${executorMetaRes._error}`
            : null,
          mcpStatesRes?._error
            ? `GetMcpServerStates: ${mcpStatesRes._error}`
            : null,
        ].filter(Boolean),
      },
    };
  };

  app.api('/api/context', handleContext, 'POST');
  app.api('/api/context', handleContext, 'GET');

  return app;
}

// Run automatically when executed as the main entrypoint
const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const app = await createInspectorApp();
  await app.run();
}
