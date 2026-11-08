# Antigravity Context Inspector Plugin

A Claude-style **Context Inspector & Optimizer** plugin and auxiliary pane (`SIDECAR_UI_ENTRYPOINT_AUX_PANE`) for Google Antigravity.

## Features

- **Claude-Style Context Breakdown**: Visualizes real-time context window usage (`% used`, `used / max` tokens, stacked distribution bar) across:
  - **Messages** (`TOKEN_TYPE_CHAT_MESSAGES`)
  - **System tools** (built-in tool declarations)
  - **MCP tools (eager)** (eagerly injected `mcp_<server>_<tool>` schemas)
  - **System prompt** (core prompt sections: `<featured_plugins>`, `<terminal_sandbox>`, `<artifacts>`, etc.)
  - **Skills** (`<skills>` frontmatter index)
  - **MCP server index** (`<mcp_servers>` lazy tool name directory)
  - **Rules & memory files** (`<user_rules>`)
  - **Free space**
- **Deferred Context Accounting**: Calculates deferred tokens saved on disk by Antigravity's lazy MCP tool loader (`~/.gemini/antigravity/mcp/<server>/<tool>.json`) and progressive skill disclosure (`SKILL.md` body vs. YAML frontmatter).
- **Antigravity Budget Gauges**: Tracks the **20,000-token Customization Budget** and **20,000-token Rules Budget** enforced by the local Language Server (`GetTokenBase`), plus API Prompt Cache hit rate (`cacheReadTokens / (inputTokens + cacheReadTokens)`).
- **Interactive Drill-Down Accordions**: Searchable `<details>` panels for MCP servers & tools (`EAGER` vs. `LAZY`), Skills (grouped by plugin/scope), System tools, System prompt sections, Rules files, and heaviest chat trajectory steps.
- **One-Click Context Optimization**: Surfaces actionable insights and a one-click **`/compact`** trigger via `window.sidecar.agent.sendMessage('/compact')`.
- **Companion Agent Skill (`context-inspector`)**: Teaches the agent how to diagnose context bloat, convert eager MCP servers to lazy mode, and surface a one-click `[Context Inspector](sidecar://context-inspector/context-inspector/)` pill in chat.

## Bundle Layout

```text
context-inspector/
├── plugin.json                                 # Antigravity Marketplace plugin manifest
├── assets/
│   └── logo.svg                                # 128x128 Marketplace card icon
├── skills/
│   └── context-inspector/
│       └── SKILL.md                            # Companion agent skill + sidecar:// pill launcher
├── sidecars/
│   └── context-inspector/
│       ├── sidecar.json                        # Sidecar launcher config (SIDECAR_UI_ENTRYPOINT_AUX_PANE)
│       ├── main.mjs                            # Node sidecar server (sidecar_sdk + standalone fallback)
│       ├── lib/
│       │   ├── lsClient.mjs                    # Connect-RPC client for LanguageServerService
│       │   └── contextAggregator.mjs           # Context window decomposition & optimization engine
│       └── ui/
│           ├── index.html                      # Auxiliary right-pane web UI (dark & light theme adaptive)
│           └── app.js                          # Frontend state & rendering logic
├── scripts/
│   └── install-sidecar.mjs                     # Bundle verification & installation helper
└── test/
    └── contextAggregator.test.mjs              # Unit & integration test suite
```

## Installation

```bash
rm -rf ~/.gemini/config/plugins/context-inspector
cp -R /Users/wenwei/Documents/antigravity/usage ~/.gemini/config/plugins/context-inspector
```

## Development & Testing

```bash
# Run unit, HTTP integration, and Marketplace manifest tests
npm test

# Verify bundle files and print install instructions
npm run setup

# Run standalone server locally
npm start
```
