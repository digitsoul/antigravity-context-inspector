const urlParams = new URLSearchParams(window.location.search);
const gatewayToken = urlParams.get('token') || '';

const state = {
  conversationId:
    (window.sidecar && window.sidecar.conversationId) ||
    urlParams.get('conversationId') ||
    '',
  workspaceUris: [],
  report: null,
  conversations: [],
  mcpFilter: '',
  skillsFilter: '',
};

const apiFetch = (url, options = {}) => {
  let targetUrl = url;
  if (gatewayToken) {
    const sep = targetUrl.includes('?') ? '&' : '?';
    targetUrl = `${targetUrl}${sep}token=${encodeURIComponent(gatewayToken)}`;
  }
  if (window.sidecar && typeof window.sidecar.fetch === 'function') {
    return window.sidecar.fetch(targetUrl, options);
  }
  return window.fetch(targetUrl, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(gatewayToken ? { 'X-Sidecar-Token': gatewayToken } : {}),
      ...(options.headers || {}),
    },
  });
};

function fmtTokens(n) {
  const num = Number(n || 0);
  if (num >= 1_000_000) {
    return `${(num / 1_000_000).toFixed(num % 1_000_000 === 0 ? 0 : 1)}M`;
  }
  if (num >= 10_000) {
    return `${(num / 1_000).toFixed(1)}k`;
  }
  if (num >= 1_000) {
    return `${(num / 1_000).toFixed(1)}k`;
  }
  return String(num);
}

function fmtPct(pct) {
  const num = Number(pct || 0);
  if (num === 0) return '0.0%';
  if (num < 0.1) return '<0.1%';
  return `${num.toFixed(1)}%`;
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatWorkspaceUri(uris = []) {
  if (!uris.length) return 'Default Workspace';
  const first = uris[0].replace(/^file:\/\//, '');
  const parts = first.split('/').filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[parts.length - 1]} · ~/${parts.slice(-2).join('/')}`;
  }
  return first;
}

function renderReport(report) {
  if (!report) return;
  state.report = report;

  // 1. Error / Diagnostic Banner
  const errBanner = document.getElementById('error-banner');
  const errs = report.diagnostics?.errors || [];
  if (errs.length > 0) {
    errBanner.style.display = 'block';
    errBanner.textContent = errs.join(' | ');
  } else {
    errBanner.style.display = 'none';
  }

  // 2. Environment Header
  document.getElementById('model-badge').textContent =
    report.model?.displayName || 'Gemini';
  document.getElementById('workspace-label').textContent = formatWorkspaceUri(
    report.workspaceUris
  );
  document.getElementById('turn-badge').textContent = `${
    report.summary?.turnCount || 0
  } turns · ${report.summary?.stepCount || 0} steps`;

  const modeEl = document.getElementById('mode-indicator');
  if (report.hasLiveConversation) {
    modeEl.textContent = 'Live Trajectory';
    modeEl.className = 'pill good';
  } else {
    modeEl.textContent = 'Baseline Only';
    modeEl.className = 'pill warn';
  }

  // 3. Context Usage Headline & Stacked Bar
  const s = report.summary || {};
  const pctText =
    s.percentUsed >= 10
      ? `${s.percentUsed.toFixed(1)}% used`
      : `${s.percentUsed.toFixed(1)}% used`;
  document.getElementById('usage-pct').textContent = pctText;
  document.getElementById('usage-ratio').textContent = `${fmtTokens(
    s.estimatedTokensUsed
  )} / ${fmtTokens(s.maxContextTokens)}`;

  const barEl = document.getElementById('stacked-bar');
  const segmentsHtml = (report.categories || [])
    .filter((c) => c.tokens > 0)
    .map((c) => {
      const widthPct = Math.max(0.6, c.percent);
      return `<div class="bar-segment" style="width:${widthPct.toFixed(
        2
      )}%;background:${esc(c.color)};" title="${esc(c.label)}: ${c.tokens.toLocaleString()} tokens (${fmtPct(
        c.percent
      )})"></div>`;
    })
    .join('');
  barEl.innerHTML = segmentsHtml;

  // 4. Category Breakdown Rows + Free Space + Deferred Rows (Claude Layout)
  const catListEl = document.getElementById('category-list');
  const activeCatRows = (report.categories || [])
    .map(
      (c) => `
      <div class="category-row active" title="${c.tokens.toLocaleString()} tokens">
        <span class="category-dot" style="background:${esc(c.color)}"></span>
        <span class="category-name">${esc(c.label)}</span>
        <span class="category-tokens">${fmtTokens(c.tokens)}</span>
        <span class="category-pct">${fmtPct(c.percent)}</span>
      </div>`
    )
    .join('');

  const freeSpaceRow = `
    <div class="category-row" title="${(s.freeTokens || 0).toLocaleString()} tokens free">
      <span class="category-dot" style="background:var(--track-bg);border:1px solid var(--text-subtle)"></span>
      <span class="category-name">Free space</span>
      <span class="category-tokens">${fmtTokens(s.freeTokens)}</span>
      <span class="category-pct">${fmtPct(s.freePercent)}</span>
    </div>`;

  const deferred = report.deferred || {};
  const deferredRows = `
    <div class="category-divider"></div>
    <div class="category-row" title="Lazy MCP tool schemas stored on disk in ~/.gemini/antigravity/mcp/ and loaded only when called">
      <span class="category-dot" style="background:var(--text-subtle)"></span>
      <span class="category-name">MCP tools (deferred)</span>
      <span class="category-tokens">${fmtTokens(deferred.mcpToolsTokens)}</span>
      <span class="category-pct">—</span>
    </div>
    <div class="category-row" title="Full SKILL.md bodies on disk loaded only when a skill is activated">
      <span class="category-dot" style="background:var(--text-subtle)"></span>
      <span class="category-name">Skills bodies (deferred)</span>
      <span class="category-tokens">${fmtTokens(deferred.skillsTokens)}</span>
      <span class="category-pct">—</span>
    </div>`;

  catListEl.innerHTML = activeCatRows + freeSpaceRow + deferredRows;

  // 5. Antigravity Budgets & Cache Strip
  const custB = report.budgets?.customization || { used: 0, max: 20000, percent: 0 };
  document.getElementById('cust-budget-label').textContent = `${fmtTokens(
    custB.used
  )} / ${fmtTokens(custB.max)}`;
  document.getElementById('cust-budget-fill').style.width = `${Math.min(
    100,
    custB.percent
  ).toFixed(1)}%`;

  const rulesB = report.budgets?.rules || { used: 0, max: 20000, percent: 0 };
  document.getElementById('rules-budget-label').textContent = `${fmtTokens(
    rulesB.used
  )} / ${fmtTokens(rulesB.max)}`;
  document.getElementById('rules-budget-fill').style.width = `${Math.min(
    100,
    rulesB.percent
  ).toFixed(1)}%`;

  const api = report.apiUsage || {};
  const stripEl = document.getElementById('telemetry-strip');
  const cacheClass = api.cacheHitRate >= 80 ? 'pill good' : 'pill';
  stripEl.innerHTML = `
    <span class="${cacheClass}" title="Prompt cache hit ratio on the latest turn">
      ⚡ ${api.cacheHitRate.toFixed(1)}% cached (${fmtTokens(api.cacheReadTokens)} read)
    </span>
    <span class="pill" title="Uncached input tokens billed on the latest turn">
      +${fmtTokens(api.inputTokens)} new input
    </span>
    <span class="pill" title="Output + thinking tokens on the latest turn">
      ${fmtTokens(api.outputTokens + api.thinkingOutputTokens)} output
    </span>
  `;

  // 6. Drill-Down Sections
  renderMcpDrilldown();
  renderSkillsDrilldown();
  renderSystemToolsDrilldown();
  renderSystemPromptDrilldown();
  renderRulesDrilldown();
  renderStepsDrilldown();
  renderRecommendations();
}

function renderMcpDrilldown() {
  const details = state.report?.details;
  if (!details) return;
  const servers = details.mcpServers || [];
  document.getElementById('mcp-summary-count').textContent = `${
    details.totalMcpToolsCount || 0
  } tools · ${servers.length} servers`;

  const q = state.mcpFilter.trim().toLowerCase();
  const listEl = document.getElementById('mcp-servers-list');

  const filtered = servers
    .map((srv) => {
      if (!q) return srv;
      const srvMatches =
        srv.serverName.toLowerCase().includes(q) ||
        (srv.pluginName && srv.pluginName.toLowerCase().includes(q));
      const matchingTools = (srv.tools || []).filter((t) =>
        t.name.toLowerCase().includes(q)
      );
      if (srvMatches) return srv;
      if (matchingTools.length > 0) {
        return { ...srv, tools: matchingTools };
      }
      return null;
    })
    .filter(Boolean);

  if (filtered.length === 0) {
    listEl.innerHTML = `<div style="color:var(--text-secondary);font-size:11px;padding:4px 0;">No matching MCP servers or tools.</div>`;
    return;
  }

  listEl.innerHTML = filtered
    .map((srv) => {
      const modeClass = srv.mode === 'EAGER' ? 'tag eager' : 'tag lazy';
      const deferredNote =
        srv.deferredTokens > 0
          ? `<span class="metric-deferred" title="Deferred full JSON schema tokens">+${fmtTokens(
              srv.deferredTokens
            )} def</span>`
          : '';
      const toolsRows = (srv.tools || [])
        .map(
          (t) => `
          <div class="item-row">
            <div class="item-main">
              <span class="item-title" title="${esc(t.name)}">${esc(t.name)}</span>
            </div>
            <div class="item-metrics">
              <span class="metric-active" title="Active tokens in prompt">${
                t.activeTokens
              }t</span>
              ${
                t.deferredTokens > 0
                  ? `<span class="metric-deferred" title="Deferred full schema tokens">(+${fmtTokens(
                      t.deferredTokens
                    )} schema)</span>`
                  : ''
              }
            </div>
          </div>`
        )
        .join('');

      return `
        <details class="nested-server" ${q ? 'open' : ''}>
          <summary>
            <div class="item-main">
              <span class="${modeClass}">${esc(srv.mode)}</span>
              <span class="item-title" title="${esc(srv.serverName)}">${esc(
        srv.serverName
      )}</span>
              <span style="color:var(--text-secondary);font-size:10.5px;">(${
                srv.tools.length
              })</span>
            </div>
            <div class="item-metrics">
              <span class="metric-active" title="Active prompt tokens">${fmtTokens(
                srv.activeTokens
              )}</span>
              ${deferredNote}
            </div>
          </summary>
          <div class="nested-tools">
            ${toolsRows}
          </div>
        </details>`;
    })
    .join('');
}

function renderSkillsDrilldown() {
  const skills = state.report?.details?.skills || [];
  document.getElementById('skills-summary-count').textContent = String(
    skills.length
  );

  const q = state.skillsFilter.trim().toLowerCase();
  const filtered = q
    ? skills.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          (s.pluginName && s.pluginName.toLowerCase().includes(q)) ||
          (s.scope && s.scope.toLowerCase().includes(q))
      )
    : skills;

  const listEl = document.getElementById('skills-list');
  if (filtered.length === 0) {
    listEl.innerHTML = `<div style="color:var(--text-secondary);font-size:11px;padding:4px 0;">No matching skills.</div>`;
    return;
  }

  listEl.innerHTML = filtered
    .map((s) => {
      const badge =
        s.scope === 'BUILTIN'
          ? `<span class="tag builtin">builtin</span>`
          : s.pluginName
            ? `<span class="tag">${esc(s.pluginName.replace(/-plugin$/, ''))}</span>`
            : `<span class="tag">${esc(s.scope)}</span>`;
      return `
        <div class="item-row" title="${esc(s.path || s.name)}">
          <div class="item-main">
            ${badge}
            <span class="item-title">${esc(s.name)}</span>
          </div>
          <div class="item-metrics">
            <span class="metric-active" title="Active frontmatter description tokens">${
              s.activeTokens
            }t</span>
            ${
              s.deferredTokens > 0
                ? `<span class="metric-deferred" title="Deferred SKILL.md body tokens on disk">+${fmtTokens(
                    s.deferredTokens
                  )} file</span>`
                : ''
            }
          </div>
        </div>`;
    })
    .join('');
}

function renderSystemToolsDrilldown() {
  const sysTools = state.report?.details?.systemTools || [];
  document.getElementById('systools-summary-count').textContent = String(
    sysTools.length
  );
  const el = document.getElementById('systools-list');
  el.innerHTML = sysTools
    .map(
      (t) => `
      <div class="item-row">
        <div class="item-main">
          <span class="item-title">${esc(t.name)}</span>
        </div>
        <div class="item-metrics">
          <span class="metric-active">${t.numTokens.toLocaleString()}t</span>
        </div>
      </div>`
    )
    .join('');
}

function renderSystemPromptDrilldown() {
  const sections = state.report?.details?.systemPromptSections || [];
  document.getElementById('sysprompt-summary-count').textContent = String(
    sections.length
  );
  const el = document.getElementById('sysprompt-list');
  el.innerHTML = sections
    .map(
      (sec) => `
      <div class="item-row">
        <div class="item-main">
          <span class="item-title">&lt;${esc(sec.name)}&gt;</span>
        </div>
        <div class="item-metrics">
          <span class="metric-active">${sec.numTokens.toLocaleString()}t</span>
        </div>
      </div>`
    )
    .join('');
}

function renderRulesDrilldown() {
  const rules = state.report?.details?.rules || [];
  document.getElementById('rules-summary-count').textContent = String(
    rules.length
  );
  const el = document.getElementById('rules-list');
  if (rules.length === 0) {
    el.innerHTML = `<div style="color:var(--text-secondary);font-size:11px;">No rule files configured.</div>`;
    return;
  }
  el.innerHTML = rules
    .map(
      (r) => `
      <div class="item-row" title="${esc(r.path)}">
        <div class="item-main">
          <span class="tag ${r.mode === 'ALWAYS_ON' ? 'eager' : 'lazy'}">${esc(
        r.mode
      )}</span>
          <span class="item-title">${esc(r.name)}</span>
        </div>
        <div class="item-metrics">
          <span class="metric-active">${r.activeTokens}t</span>
          ${
            r.deferredTokens > 0
              ? `<span class="metric-deferred">+${fmtTokens(
                  r.deferredTokens
                )} def</span>`
              : ''
          }
        </div>
      </div>`
    )
    .join('');
}

function renderStepsDrilldown() {
  const steps = state.report?.details?.topHeavySteps || [];
  const totalSteps = state.report?.summary?.stepCount || 0;
  document.getElementById('steps-summary-count').textContent = `${totalSteps} total`;
  const el = document.getElementById('steps-list');
  if (steps.length === 0) {
    el.innerHTML = `<div style="color:var(--text-secondary);font-size:11px;">No chat message steps recorded yet.</div>`;
    return;
  }
  el.innerHTML = steps
    .map(
      (st) => `
      <div class="item-row">
        <div class="item-main">
          <span class="tag">#${st.stepIndex ?? '?'}</span>
          <span class="item-title">${esc(st.stepType)}</span>
        </div>
        <div class="item-metrics">
          <span class="metric-active">${st.numTokens.toLocaleString()}t</span>
        </div>
      </div>`
    )
    .join('');
}

function renderRecommendations() {
  const recs = state.report?.recommendations || [];
  const el = document.getElementById('rec-list');
  if (recs.length === 0) {
    el.innerHTML = `<div style="color:var(--text-secondary);font-size:11.5px;">Context window is lean and well-optimized.</div>`;
    return;
  }

  el.innerHTML = recs
    .map((r, idx) => {
      const actionBtn =
        r.action === 'compact'
          ? `<button type="button" class="action-btn" data-action="compact" data-idx="${idx}">
               ✨ Send <code>/compact</code> to chat
             </button>`
          : '';
      return `
        <div class="rec-card ${esc(r.severity)}">
          <div class="rec-title">${esc(r.title)}</div>
          <div class="rec-desc">${esc(r.description)}</div>
          ${actionBtn}
        </div>`;
    })
    .join('');

  el.querySelectorAll('button[data-action="compact"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (window.sidecar?.agent?.sendMessage) {
        btn.disabled = true;
        btn.textContent = 'Sent /compact to chat ✓';
        await window.sidecar.agent.sendMessage(
          '/compact',
          state.conversationId
        );
      }
    });
  });
}

async function loadConversations() {
  try {
    const res = await apiFetch('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    const data = await res.json();
    state.conversations = data.conversations || [];
    if (!state.conversationId && data.defaultConversationId) {
      state.conversationId = data.defaultConversationId;
    }
    const select = document.getElementById('conv-select');
    if (state.conversations.length === 0) {
      select.innerHTML = `<option value="${esc(state.conversationId)}">${
        state.conversationId
          ? `Conversation ${state.conversationId.slice(0, 8)}...`
          : 'Current Conversation'
      }</option>`;
      return;
    }

    // Ensure current conversationId is in the dropdown even if not in summaries
    const exists = state.conversations.some(
      (c) => c.cascadeId === state.conversationId
    );
    const items = exists
      ? state.conversations
      : [
          ...(state.conversationId
            ? [
                {
                  cascadeId: state.conversationId,
                  summary: `Active (${state.conversationId.slice(0, 8)})`,
                  stepCount: 0,
                },
              ]
            : []),
          ...state.conversations,
        ];

    select.innerHTML = items
      .map((c) => {
        const selected = c.cascadeId === state.conversationId ? 'selected' : '';
        const label = `${c.summary} (${c.stepCount || 0} steps)`;
        return `<option value="${esc(c.cascadeId)}" ${selected}>${esc(
          label
        )}</option>`;
      })
      .join('');
  } catch (err) {
    console.error('Failed to load conversations:', err);
  }
}

async function refreshContext() {
  const btn = document.getElementById('refresh-btn');
  btn.textContent = '↻ ...';
  try {
    const res = await apiFetch('/api/context', {
      method: 'POST',
      body: JSON.stringify({
        conversationId: state.conversationId,
        workspaceUris: state.workspaceUris,
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${errText || res.statusText}`);
    }
    const report = await res.json();
    if (!state.conversationId && report.conversationId) {
      state.conversationId = report.conversationId;
    }
    renderReport(report);
  } catch (err) {
    const errBanner = document.getElementById('error-banner');
    errBanner.style.display = 'block';
    errBanner.textContent = `Failed to load context telemetry: ${err.message}`;
  } finally {
    btn.textContent = '↻ Refresh';
  }
}

// Event Listeners
document.getElementById('refresh-btn').addEventListener('click', () => {
  refreshContext();
});

document.getElementById('conv-select').addEventListener('change', (e) => {
  state.conversationId = e.target.value;
  refreshContext();
});

document.getElementById('mcp-filter').addEventListener('input', (e) => {
  state.mcpFilter = e.target.value;
  renderMcpDrilldown();
});

document.getElementById('skills-filter').addEventListener('input', (e) => {
  state.skillsFilter = e.target.value;
  renderSkillsDrilldown();
});

if (window.sidecar && typeof window.sidecar.onWorkspaceChange === 'function') {
  window.sidecar.onWorkspaceChange((uris) => {
    state.workspaceUris = uris || [];
    refreshContext();
  });
}

// Initial boot + periodic refresh when visible
(async () => {
  await loadConversations();
  await refreshContext();
  setInterval(() => {
    if (document.visibilityState === 'visible') {
      refreshContext();
    }
  }, 10000);
})();
