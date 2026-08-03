import { describe, expect, it } from 'vitest';
import {
  CLAUDEDOCK_WEB_RESEARCH_AGENTS,
  CLAUDEDOCK_WEB_RESEARCH_AGENT_NAME,
  CLAUDEDOCK_WEB_RESEARCH_SYSTEM_PROMPT,
} from '../src/main/claude-web-research';

describe('ClaudeDock web research subagent', () => {
  it('isolates web tools at high effort while preserving the parent model', () => {
    const definition = CLAUDEDOCK_WEB_RESEARCH_AGENTS[CLAUDEDOCK_WEB_RESEARCH_AGENT_NAME];

    expect(definition.effort).toBe('high');
    expect(definition.model).toBe('inherit');
    expect(definition.background).toBe(false);
    expect(definition.tools).toEqual(['WebSearch', 'WebFetch']);
    expect(definition.tools).not.toContain('Agent');
  });

  it('requires main-thread delegation without changing the main effort', () => {
    expect(CLAUDEDOCK_WEB_RESEARCH_SYSTEM_PROMPT).toContain(CLAUDEDOCK_WEB_RESEARCH_AGENT_NAME);
    expect(CLAUDEDOCK_WEB_RESEARCH_SYSTEM_PROMPT).toContain('MUST delegate');
    expect(CLAUDEDOCK_WEB_RESEARCH_SYSTEM_PROMPT).toContain(
      'Do not lower or change the main effort',
    );
  });
});
