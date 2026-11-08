import { existsSync, statSync, readFileSync } from 'node:fs';

/**
 * Estimates token count from raw character count (~3.5 chars per token for English/JSON).
 */
export function estimateTokensFromChars(charCount) {
  if (!charCount || charCount <= 0) return 0;
  return Math.ceil(charCount / 3.5);
}

/**
 * Safely reads the size in bytes (and optional frontmatter description) of a local file.
 */
function inspectFileOnDisk(filePath) {
  if (!filePath || !existsSync(filePath)) {
    return { exists: false, sizeBytes: 0, estimatedFullTokens: 0 };
  }
  try {
    const st = statSync(filePath);
    return {
      exists: true,
      sizeBytes: st.size,
      estimatedFullTokens: estimateTokensFromChars(st.size),
    };
  } catch {
    return { exists: false, sizeBytes: 0, estimatedFullTokens: 0 };
  }
}

/**
 * Redacts sensitive tokens/keys in CLI args or headers before sending to UI.
 */
export function redactArgs(args = []) {
  if (!Array.isArray(args)) return [];
  return args.map((arg) => {
    if (typeof arg !== 'string') return String(arg);
    return arg.replace(
      /(api[-_]?key|token|authorization|secret|bearer)\s*[:=]\s*([^\s,"']+)/gi,
      '$1: <REDACTED>'
    );
  });
}

/**
 * Normalizes and combines Language Server RPC responses into a Claude-style
 * Context Window breakdown + Antigravity budget & optimization analysis.
 */
export function buildContextReport({
  conversationId = '',
  workspaceUris = [],
  tokenBaseRes = {},
  generatorMetaRes = {},
  executorMetaRes = {},
  mcpStatesRes = {},
} = {}) {
  const genList = Array.isArray(generatorMetaRes?.generatorMetadata)
    ? generatorMetaRes.generatorMetadata
    : [];
  const execList = Array.isArray(executorMetaRes?.executorMetadata)
    ? executorMetaRes.executorMetadata
    : [];

  // Find the most recent generatorMetadata entry that carries a tokenBreakdown,
  // or fall back to the final entry.
  const latestGen = genList.length > 0 ? genList[genList.length - 1] : null;
  let latestWithBreakdown = latestGen;
  for (let i = genList.length - 1; i >= 0; i--) {
    const tb =
      genList[i]?.chatModel?.chatStartMetadata?.contextWindowMetadata
        ?.tokenBreakdown;
    if (tb && Array.isArray(tb.groups) && tb.groups.length > 0) {
      latestWithBreakdown = genList[i];
      break;
    }
  }

  const chatModel = latestWithBreakdown?.chatModel || latestGen?.chatModel || {};
  const cwMeta = chatModel?.chatStartMetadata?.contextWindowMetadata || {};
  const rawBreakdown = cwMeta?.tokenBreakdown || { groups: [], totalTokens: 0 };

  const custBreakdown = tokenBaseRes?.customizationTokenBase || {
    groups: [],
    totalTokens: 0,
  };

  // --- 1. Extract Loaded Customizations Metadata (Plugin, Scope, Path) ---
  const latestExec = execList.length > 0 ? execList[execList.length - 1] : null;
  const rawCustomizations =
    latestExec?.loadedCustomizations?.customizations || [];

  const skillMetaByName = new Map();
  const ruleMetaByPath = new Map();
  const mcpMetaByName = new Map();
  const pluginsList = [];

  for (const item of rawCustomizations) {
    const scope = (item.scope || 'SCOPE_GLOBAL').replace(/^SCOPE_/, '');
    const status = (item.status || 'STATUS_ENABLED').replace(/^STATUS_/, '');
    if (item.type === 'REFRESH_CUSTOMIZATION_TYPE_SKILL' && item.name) {
      skillMetaByName.set(item.name, {
        name: item.name,
        path: item.path || '',
        scope,
        status,
        pluginName: item.pluginName || (scope === 'BUILTIN' ? 'builtin' : null),
      });
    } else if (item.type === 'REFRESH_CUSTOMIZATION_TYPE_RULE' && item.path) {
      ruleMetaByPath.set(item.path, {
        path: item.path,
        scope,
        status,
        pluginName: item.pluginName || null,
      });
    } else if (item.type === 'REFRESH_CUSTOMIZATION_TYPE_MCP' && item.name) {
      mcpMetaByName.set(item.name, {
        name: item.name,
        path: item.path || '',
        scope,
        status,
        pluginName: item.pluginName || null,
      });
    } else if (item.type === 'REFRESH_CUSTOMIZATION_TYPE_PLUGIN') {
      const dir = item.path ? item.path.split('/').filter(Boolean).pop() : item.name;
      pluginsList.push({
        name: item.name,
        dir,
        path: item.path || '',
        scope,
        status,
        version: item.version || '',
        customizationLink: dir ? `customization://${dir}` : null,
      });
    }
  }

  // --- 2. Parse Raw Groups from GeneratorMetadata ---
  const sysPromptGroup = rawBreakdown.groups?.find(
    (g) => g.type === 'TOKEN_TYPE_SYSTEM_PROMPT'
  );
  const toolsGroup = rawBreakdown.groups?.find(
    (g) => g.type === 'TOKEN_TYPE_TOOLS'
  );
  const messagesGroup = rawBreakdown.groups?.find(
    (g) => g.type === 'TOKEN_TYPE_CHAT_MESSAGES'
  );

  // Decompose System Prompt sections into:
  // - Core System Prompt sections
  // - Skills section (`skills`)
  // - MCP Server Instructions section (`mcp_servers`)
  // - User Rules section (`user_rules`)
  const sysPromptChildren = sysPromptGroup?.children || [];
  const corePromptSections = [];
  let skillsSectionTokens = 0;
  let mcpServersSectionTokens = 0;
  let userRulesSectionTokens = 0;

  for (const child of sysPromptChildren) {
    if (child.name === 'skills') {
      skillsSectionTokens += child.numTokens || 0;
    } else if (child.name === 'mcp_servers') {
      mcpServersSectionTokens += child.numTokens || 0;
    } else if (child.name === 'user_rules') {
      userRulesSectionTokens += child.numTokens || 0;
    } else {
      corePromptSections.push({
        name: child.name,
        numTokens: child.numTokens || 0,
      });
    }
  }
  corePromptSections.sort((a, b) => b.numTokens - a.numTokens);

  // Decompose Tools into:
  // - Built-in System Tools (non `mcp_*`)
  // - Eager MCP Tools (`mcp_<server>_<tool>`)
  const toolsChildren = toolsGroup?.children || [];
  const systemToolsList = [];
  const eagerMcpToolTokensByFullName = new Map();
  let systemToolsTokens = 0;
  let eagerMcpToolsTokens = 0;

  for (const tool of toolsChildren) {
    const tName = tool.name || '';
    const tTokens = tool.numTokens || 0;
    if (tName.startsWith('mcp_')) {
      eagerMcpToolsTokens += tTokens;
      eagerMcpToolTokensByFullName.set(tName, tTokens);
    } else {
      systemToolsTokens += tTokens;
      systemToolsList.push({
        name: tName,
        numTokens: tTokens,
      });
    }
  }
  systemToolsList.sort((a, b) => b.numTokens - a.numTokens);

  // --- 3. Build Detailed Skills Inventory (Active Description vs. Deferred Full SKILL.md) ---
  const custSkillsGroup = custBreakdown.groups?.find(
    (g) => g.type === 'TOKEN_TYPE_SKILLS'
  );
  const userSkillTokensMap = new Map();
  for (const s of custSkillsGroup?.children || []) {
    userSkillTokensMap.set(s.name, s.numTokens || 0);
  }

  const userSkillsTotalTokens = custSkillsGroup?.numTokens || 0;
  const builtinSkillsTotalTokens = Math.max(
    0,
    skillsSectionTokens - userSkillsTotalTokens
  );

  // Count builtin skills so we can apportion builtinSkillsTotalTokens if not individually listed in GetTokenBase
  const builtinSkillEntries = [...skillMetaByName.values()].filter(
    (s) => s.scope === 'BUILTIN'
  );
  const avgBuiltinSkillTokens =
    builtinSkillEntries.length > 0
      ? Math.round(builtinSkillsTotalTokens / builtinSkillEntries.length)
      : 0;

  const allSkillNames = new Set([
    ...userSkillTokensMap.keys(),
    ...skillMetaByName.keys(),
  ]);

  const skillsDetails = [];
  let deferredSkillsTokens = 0;

  for (const name of allSkillNames) {
    const meta = skillMetaByName.get(name) || {
      name,
      path: '',
      scope: 'GLOBAL',
      status: 'ENABLED',
      pluginName: null,
    };
    const isBuiltin = meta.scope === 'BUILTIN';
    const activeTokens = userSkillTokensMap.has(name)
      ? userSkillTokensMap.get(name)
      : isBuiltin
        ? avgBuiltinSkillTokens
        : 0;

    const diskInfo = inspectFileOnDisk(meta.path);
    const deferredBodyTokens = Math.max(
      0,
      diskInfo.estimatedFullTokens - activeTokens
    );
    deferredSkillsTokens += deferredBodyTokens;

    skillsDetails.push({
      name,
      activeTokens,
      deferredTokens: deferredBodyTokens,
      fullFileTokens: diskInfo.estimatedFullTokens,
      sizeBytes: diskInfo.sizeBytes,
      scope: meta.scope,
      pluginName: meta.pluginName,
      path: meta.path,
    });
  }
  skillsDetails.sort((a, b) => b.activeTokens - a.activeTokens);

  // --- 4. Build Detailed MCP Servers & Tools Inventory (Eager vs. Lazy / Deferred) ---
  const custMcpGroup = custBreakdown.groups?.find(
    (g) => g.type === 'TOKEN_TYPE_MCP_TOOLS'
  );
  const custMcpServerMap = new Map();
  for (const srv of custMcpGroup?.children || []) {
    const toolMap = new Map();
    for (const t of srv.children || []) {
      toolMap.set(t.name, t.numTokens || 0);
    }
    custMcpServerMap.set(srv.name, {
      numTokens: srv.numTokens || 0,
      toolMap,
    });
  }

  const mcpStates = Array.isArray(mcpStatesRes?.states)
    ? mcpStatesRes.states
    : [];
  const mcpStateByServer = new Map();
  for (const st of mcpStates) {
    const sName = st?.spec?.serverName;
    if (sName) {
      mcpStateByServer.set(sName, st);
    }
  }

  const allMcpServerNames = new Set([
    ...custMcpServerMap.keys(),
    ...mcpStateByServer.keys(),
    ...mcpMetaByName.keys(),
  ]);

  const mcpServersDetails = [];
  let totalDeferredMcpTokens = 0;
  let totalMcpToolsCount = 0;

  for (const serverName of allMcpServerNames) {
    const custSrv = custMcpServerMap.get(serverName);
    const state = mcpStateByServer.get(serverName);
    const meta = mcpMetaByName.get(serverName);

    const stateTools = Array.isArray(state?.tools) ? state.tools : [];
    const stateToolByName = new Map(stateTools.map((t) => [t.name, t]));

    const toolNames = new Set([
      ...(custSrv ? custSrv.toolMap.keys() : []),
      ...stateToolByName.keys(),
    ]);

    const tools = [];
    let serverActiveSchemaTokens = 0;
    let serverPromptIndexTokens = 0;
    let serverDeferredTokens = 0;
    let hasEagerTools = false;

    for (const toolName of toolNames) {
      const fullEagerName = `mcp_${serverName}_${toolName}`;
      const baseTokens = custSrv?.toolMap.get(toolName) || 0;
      const specToolCfg = state?.spec?.toolConfig?.[toolName];

      // Determine whether the tool is currently EAGER or LAZY:
      // 1. If GetMcpServerStates has `spec.toolConfig` (live config), check `eager === true`
      //    or if GetTokenBase reports full schema tokens (> 50 tokens) for this tool.
      // 2. Otherwise fall back to the trajectory's `TOKEN_TYPE_TOOLS` snapshot.
      const isLiveLazyOverride =
        specToolCfg !== undefined &&
        specToolCfg.eager !== true &&
        baseTokens > 0 &&
        baseTokens <= 30;
      const isEager = isLiveLazyOverride
        ? false
        : Boolean(
            specToolCfg?.eager === true ||
              eagerMcpToolTokensByFullName.has(fullEagerName) ||
              baseTokens > 50
          );
      const eagerSchemaTokens =
        eagerMcpToolTokensByFullName.get(fullEagerName) || baseTokens;

      const stTool = stateToolByName.get(toolName);
      const schemaChars =
        (stTool?.description?.length || 0) +
        (stTool?.jsonSchemaString?.length || 0) +
        toolName.length;
      const estimatedFullSchemaTokens =
        schemaChars > 0 ? estimateTokensFromChars(schemaChars) : baseTokens;

      if (isEager) {
        hasEagerTools = true;
        serverActiveSchemaTokens += eagerSchemaTokens;
        tools.push({
          name: toolName,
          mode: 'EAGER',
          activeTokens: eagerSchemaTokens,
          deferredTokens: 0,
          fullSchemaTokens: eagerSchemaTokens,
        });
      } else {
        serverPromptIndexTokens += baseTokens;
        const deferred = Math.max(0, estimatedFullSchemaTokens - baseTokens);
        serverDeferredTokens += deferred;
        tools.push({
          name: toolName,
          mode: 'LAZY',
          activeTokens: baseTokens,
          deferredTokens: deferred,
          fullSchemaTokens: estimatedFullSchemaTokens,
        });
      }
    }

    tools.sort(
      (a, b) =>
        b.activeTokens - a.activeTokens || b.deferredTokens - a.deferredTokens
    );

    totalDeferredMcpTokens += serverDeferredTokens;
    totalMcpToolsCount += tools.length;

    if (!hasEagerTools && custSrv?.numTokens > serverPromptIndexTokens) {
      serverPromptIndexTokens = custSrv.numTokens;
    }

    const totalServerActiveTokens =
      serverActiveSchemaTokens + serverPromptIndexTokens;

    mcpServersDetails.push({
      serverName,
      mode: hasEagerTools ? 'EAGER' : 'LAZY',
      status: (state?.status || 'MCP_SERVER_STATUS_READY').replace(
        /^MCP_SERVER_STATUS_/,
        ''
      ),
      pluginName: meta?.pluginName || null,
      scope: meta?.scope || 'GLOBAL',
      toolCount: tools.length,
      activeTokens: totalServerActiveTokens,
      activeSchemaTokens: serverActiveSchemaTokens,
      promptIndexTokens: serverPromptIndexTokens,
      deferredTokens: serverDeferredTokens,
      command: state?.spec?.command || '',
      args: redactArgs(state?.spec?.args || []),
      tools,
    });
  }
  mcpServersDetails.sort(
    (a, b) =>
      b.activeTokens - a.activeTokens || b.deferredTokens - a.deferredTokens
  );

  // --- 5. Build Rules / Memory Files Inventory ---
  const custRulesGroup = custBreakdown.groups?.find(
    (g) => g.type === 'TOKEN_TYPE_RULES'
  );
  const rulesByPath = new Map();
  for (const r of custRulesGroup?.children || []) {
    rulesByPath.set(r.name, r.numTokens || 0);
  }
  const allRulePaths = new Set([
    ...rulesByPath.keys(),
    ...ruleMetaByPath.keys(),
  ]);
  const rulesDetails = [];
  for (const path of allRulePaths) {
    const meta = ruleMetaByPath.get(path) || {
      path,
      scope: 'GLOBAL',
      status: 'ENABLED',
      pluginName: null,
    };
    const disk = inspectFileOnDisk(path);
    const activeTokens = rulesByPath.has(path) ? rulesByPath.get(path) : 0;
    rulesDetails.push({
      name: path.split('/').pop() || path,
      path,
      activeTokens,
      deferredTokens:
        activeTokens === 0 ? disk.estimatedFullTokens : 0,
      mode: activeTokens > 0 ? 'ALWAYS_ON' : 'ON_DEMAND',
      scope: meta.scope,
      status: meta.status,
      pluginName: meta.pluginName,
    });
  }
  rulesDetails.sort((a, b) => b.activeTokens - a.activeTokens);

  // --- 6. Build Messages / Step History Breakdown ---
  const messageSteps = (messagesGroup?.children || []).map((step) => {
    const match = /^(\d+):\s*(.+)$/.exec(step.name || '');
    return {
      rawName: step.name,
      stepIndex: match ? Number(match[1]) : null,
      stepType: match ? match[2] : step.name,
      numTokens: step.numTokens || 0,
    };
  });

  const topHeavySteps = [...messageSteps]
    .sort((a, b) => b.numTokens - a.numTokens)
    .slice(0, 15);

  // Turn-by-turn trajectory growth from generatorMetadata
  const turnHistory = genList.map((gm, idx) => {
    const u = gm?.chatModel?.usage || {};
    const cw = gm?.chatModel?.chatStartMetadata?.contextWindowMetadata || {};
    const input = Number(u.inputTokens || 0);
    const cacheRead = Number(u.cacheReadTokens || 0);
    const output = Number(u.outputTokens || 0);
    return {
      turnIndex: idx + 1,
      stepIndices: gm.stepIndices || [],
      estimatedTokensUsed: cw.estimatedTokensUsed || input + cacheRead,
      inputTokens: input,
      cacheReadTokens: cacheRead,
      outputTokens: output,
    };
  });

  // --- 7. Top-Level Categories (Claude Screenshot Layout) ---
  const hasLiveConversation = Boolean(
    rawBreakdown.totalTokens && rawBreakdown.totalTokens > 0
  );

  const messagesTokens = messagesGroup?.numTokens || 0;
  const coreSystemPromptTokens = corePromptSections.reduce(
    (sum, s) => sum + s.numTokens,
    0
  );
  const activeSkillsTokens = hasLiveConversation
    ? skillsSectionTokens
    : custSkillsGroup?.numTokens || 0;
  const activeRulesTokens = hasLiveConversation
    ? userRulesSectionTokens
    : custRulesGroup?.numTokens || 0;
  const activeMcpInstructionsTokens = hasLiveConversation
    ? mcpServersSectionTokens
    : custMcpGroup?.numTokens || 0;

  const maxContextTokens = cwMeta.maxContextTokens || 256000;
  const estimatedTokensUsed = hasLiveConversation
    ? cwMeta.estimatedTokensUsed || rawBreakdown.totalTokens
    : custBreakdown.totalTokens || 0;
  const freeTokens = Math.max(0, maxContextTokens - estimatedTokensUsed);
  const percentUsed =
    maxContextTokens > 0 ? (estimatedTokensUsed / maxContextTokens) * 100 : 0;

  const pct = (tokens) =>
    maxContextTokens > 0 ? (tokens / maxContextTokens) * 100 : 0;

  const categories = [
    {
      id: 'messages',
      label: 'Messages',
      color: '#3b82f6', // Blue
      tokens: messagesTokens,
      percent: pct(messagesTokens),
      itemCount: messageSteps.length,
    },
    {
      id: 'system_tools',
      label: 'System tools',
      color: '#f97316', // Orange
      tokens: systemToolsTokens,
      percent: pct(systemToolsTokens),
      itemCount: systemToolsList.length,
    },
    {
      id: 'mcp_tools',
      label: 'MCP tools (eager)',
      color: '#10b981', // Emerald
      tokens: eagerMcpToolsTokens,
      percent: pct(eagerMcpToolsTokens),
      itemCount: eagerMcpToolTokensByFullName.size,
    },
    {
      id: 'system_prompt',
      label: 'System prompt',
      color: '#eab308', // Amber/Yellow
      tokens: coreSystemPromptTokens,
      percent: pct(coreSystemPromptTokens),
      itemCount: corePromptSections.length,
    },
    {
      id: 'skills',
      label: 'Skills',
      color: '#a855f7', // Purple
      tokens: activeSkillsTokens,
      percent: pct(activeSkillsTokens),
      itemCount: skillsDetails.length,
    },
    {
      id: 'mcp_instructions',
      label: 'MCP server index',
      color: '#14b8a6', // Teal
      tokens: activeMcpInstructionsTokens,
      percent: pct(activeMcpInstructionsTokens),
      itemCount: mcpServersDetails.length,
    },
    {
      id: 'rules',
      label: 'Rules & memory files',
      color: '#ec4899', // Pink
      tokens: activeRulesTokens,
      percent: pct(activeRulesTokens),
      itemCount: rulesDetails.length,
    },
  ];

  // --- 8. Budgets & Actionable Optimization Insights ---
  const customizationBudget =
    tokenBaseRes?.customizationBudget ||
    latestWithBreakdown?.plannerConfig?.customizationTokenBudget ||
    20000;
  const remainingCustomizationBudget =
    tokenBaseRes?.remainingBudget ??
    Math.max(0, customizationBudget - (custBreakdown.totalTokens || 0));
  const usedCustomizationBudget = Math.max(
    0,
    customizationBudget - remainingCustomizationBudget
  );

  const rulesBudget =
    tokenBaseRes?.rulesBudget ||
    latestWithBreakdown?.plannerConfig?.rulesTokenBudget ||
    20000;
  const remainingRulesBudget =
    tokenBaseRes?.remainingRulesBudget ??
    Math.max(0, rulesBudget - (custRulesGroup?.numTokens || 0));
  const usedRulesBudget = Math.max(0, rulesBudget - remainingRulesBudget);

  // Latest API Usage & Cache Metrics
  const latestUsage = chatModel?.usage || {};
  const inputTokens = Number(latestUsage.inputTokens || 0);
  const cacheReadTokens = Number(latestUsage.cacheReadTokens || 0);
  const outputTokens = Number(latestUsage.outputTokens || 0);
  const thinkingOutputTokens = Number(latestUsage.thinkingOutputTokens || 0);
  const totalPromptTokens = inputTokens + cacheReadTokens;
  const cacheHitRate =
    totalPromptTokens > 0 ? (cacheReadTokens / totalPromptTokens) * 100 : 0;

  // Generate Optimization Insights
  const recommendations = [];

  for (const srv of mcpServersDetails) {
    if (srv.mode === 'EAGER' && srv.activeTokens >= 300) {
      recommendations.push({
        severity: 'medium',
        title: `Eager MCP Server: ${srv.serverName}`,
        description: `Injects ${srv.activeTokens.toLocaleString()} tokens on every turn (${srv.toolCount} eager tools). Disable the parent plugin (${srv.pluginName || srv.serverName}) when not needed.`,
        savedTokens: srv.activeTokens,
        pluginName: srv.pluginName,
      });
    }
  }

  const heavySkills = skillsDetails.filter((s) => s.activeTokens >= 220);
  if (heavySkills.length > 0) {
    const names = heavySkills.slice(0, 3).map((s) => `${s.name} (${s.activeTokens}t)`).join(', ');
    const sum = heavySkills.reduce((acc, s) => acc + s.activeTokens, 0);
    recommendations.push({
      severity: 'low',
      title: `${heavySkills.length} Verbose Skill Descriptions (${sum.toLocaleString()} tokens)`,
      description: `Top frontmatter descriptions loaded on every turn: ${names}. Keep SKILL.md frontmatter concise and move details to body/references.`,
      savedTokens: Math.round(sum * 0.5),
    });
  }

  if (percentUsed >= 50 || messagesTokens >= 80000) {
    const estimatedCompactionSavings = Math.round(messagesTokens * 0.75);
    recommendations.push({
      severity: percentUsed >= 75 ? 'high' : 'medium',
      title: `Messages consume ${(pct(messagesTokens)).toFixed(1)}% of context (${messagesTokens.toLocaleString()} tokens)`,
      description: `Run /compact to summarize older tool outputs and conversation turns, reclaiming ~${estimatedCompactionSavings.toLocaleString()} tokens.`,
      savedTokens: estimatedCompactionSavings,
      action: 'compact',
    });
  }

  return {
    conversationId,
    workspaceUris,
    hasLiveConversation,
    model: {
      displayName: chatModel.modelDisplayName || 'Gemini (Default)',
      responseModel: chatModel.responseModel || chatModel.model || '',
    },
    summary: {
      estimatedTokensUsed,
      maxContextTokens,
      freeTokens,
      percentUsed,
      freePercent: pct(freeTokens),
      turnCount: genList.length,
      stepCount: messageSteps.length,
    },
    apiUsage: {
      inputTokens,
      cacheReadTokens,
      outputTokens,
      thinkingOutputTokens,
      cacheHitRate,
    },
    budgets: {
      customization: {
        used: usedCustomizationBudget,
        max: customizationBudget,
        remaining: remainingCustomizationBudget,
        percent:
          customizationBudget > 0
            ? (usedCustomizationBudget / customizationBudget) * 100
            : 0,
      },
      rules: {
        used: usedRulesBudget,
        max: rulesBudget,
        remaining: remainingRulesBudget,
        percent: rulesBudget > 0 ? (usedRulesBudget / rulesBudget) * 100 : 0,
      },
    },
    categories,
    deferred: {
      mcpToolsTokens: totalDeferredMcpTokens,
      skillsTokens: deferredSkillsTokens,
    },
    details: {
      skills: skillsDetails,
      mcpServers: mcpServersDetails,
      totalMcpToolsCount,
      systemTools: systemToolsList,
      systemPromptSections: corePromptSections,
      rules: rulesDetails,
      plugins: pluginsList,
      topHeavySteps,
      turnHistory,
    },
    recommendations,
  };
}
