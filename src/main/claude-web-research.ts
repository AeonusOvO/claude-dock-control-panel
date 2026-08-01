export const CLAUDEDOCK_WEB_RESEARCH_AGENT_NAME = 'claudedock-web-research';

/**
 * Claude Code accepts CLI-defined subagents as JSON. Keeping this definition on the launch command
 * makes it session-local: no project `.claude` files or user settings are created or changed.
 */
export const CLAUDEDOCK_WEB_RESEARCH_AGENTS = {
  [CLAUDEDOCK_WEB_RESEARCH_AGENT_NAME]: {
    background: false,
    description:
      'Dedicated internet research worker. Use proactively for every task that needs WebSearch or WebFetch so the main conversation never performs web tools directly.',
    effort: 'high',
    maxTurns: 30,
    model: 'inherit',
    prompt:
      'You are ClaudeDock web research worker. Perform only the delegated internet research. Use WebSearch and WebFetch as needed, preserve source URLs, distinguish sourced facts from inference, and return a concise evidence-grounded report to the parent. Do not edit files and do not delegate to another agent.',
    tools: ['WebSearch', 'WebFetch'],
  },
} as const;

/**
 * The model sees this above user prompts, so ordinary natural-language requests are routed before a
 * direct WebSearch call is produced. A PreToolUse guard supplies a deterministic fallback when the
 * model still attempts the tool in the main conversation.
 */
export const CLAUDEDOCK_WEB_RESEARCH_SYSTEM_PROMPT =
  'ClaudeDock isolates internet access from the main conversation. Whenever current information, an online lookup, URL retrieval, WebSearch, or WebFetch is needed, you MUST delegate the complete research subtask to the claudedock-web-research agent with the Agent tool. Never call WebSearch or WebFetch directly in the main conversation. After the agent returns, continue the main reasoning and synthesis yourself at the main conversation effort. Do not lower or change the main effort for web research.';
