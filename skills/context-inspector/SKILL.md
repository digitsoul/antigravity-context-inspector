---
name: context-inspector
description: Inspect and optimize the active conversation context window, customization token budget, eager vs. lazy MCP tools, skills, rules, and chat message steps. Activate when the user asks about token usage, context bloat, why an MCP server is eager or lazy, or wants to open the Context Inspector panel.
---

# Context Inspector & Optimizer Skill

Use this skill when the user asks to analyze or optimize their conversation context window, check their 20k customization or rules budgets, inspect eager vs. lazy MCP tools, or open the **Context Inspector** sidecar UI.

## 1. Surface the One-Click Context Inspector Pill

Whenever the user asks to view or inspect their context window, include the `sidecar://` pill link in your response so they can toggle the **Context Inspector** auxiliary pane with one click:

```markdown
[Context Inspector](sidecar://context-inspector/context-inspector/)
```

## 2. Querying Live Context Telemetry from the Language Server

You can run the bundled aggregator directly or query the local Antigravity Language Server (`LanguageServerService`) to get the exact token breakdown for the active conversation:

```bash
node -e '
import("./sidecars/context-inspector/lib/lsClient.mjs").then(async ({ LanguageServerClient }) => {
  const { buildContextReport } = await import("./sidecars/context-inspector/lib/contextAggregator.mjs");
  const ls = new LanguageServerClient();
  const convId = process.env.ANTIGRAVITY_CONVERSATION_ID || "";
  const uris = ["file://" + process.cwd()];
  const [tb, gen, exec, mcp] = await Promise.all([
    ls.getTokenBase(uris),
    ls.getGeneratorMetadata(convId),
    ls.getExecutorMetadatas(convId),
    ls.getMcpServerStates()
  ]);
  const report = buildContextReport({
    conversationId: convId,
    workspaceUris: uris,
    tokenBaseRes: tb,
    generatorMetaRes: gen,
    executorMetaRes: exec,
    mcpStatesRes: mcp
  });
  console.log(JSON.stringify({
    summary: report.summary,
    budgets: report.budgets,
    categories: report.categories,
    deferred: report.deferred,
    recommendations: report.recommendations
  }, null, 2));
});
'
```

## 3. Optimization Playbook

When helping the user reduce context usage, check the following sources in order of impact:

1. **Chat Messages (`TOKEN_TYPE_CHAT_MESSAGES`)**:
   - If chat messages exceed 50% of `maxContextTokens`, recommend running the `/compact` slash command to summarize earlier turns while preserving key context.
2. **Eager MCP Tools (`mcp_<server>_<tool>` in `TOKEN_TYPE_TOOLS`)**:
   - By default, Antigravity MCP servers are **LAZY** (~3–5 tokens per tool name in `<mcp_servers>`, with full JSON schemas stored on disk in `~/.gemini/antigravity/mcp/`).
   - If an MCP server shows as **EAGER**, check its `mcp_config.json` (in `~/.gemini/config/mcp_config.json` or `~/.gemini/config/plugins/<plugin>/mcp_config.json`) for `"tools": { "<tool>": { "eager": true } }`.
   - Setting `"eager": false` (or removing the `"tools"` override) converts those tools to lazy loading and saves hundreds or thousands of tokens on every turn.
3. **20,000-Token Customization Budget (`GetTokenBase`)**:
   - User/plugin skills (`TOKEN_TYPE_SKILLS`) and MCP tool indexes (`TOKEN_TYPE_MCP_TOOLS`) share a 20,000-token customization budget.
   - Keep `SKILL.md` YAML frontmatter `description` concise (< 150 tokens) and place detailed instructions in the markdown body or `references/` files so they are loaded only on demand.
   - To disable an unused plugin, give the user a `customization://<plugin-dir>` link (e.g., `[<plugin>](customization://<plugin-dir>)`) so they can toggle it off on the Customizations page.
