import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const mainSource = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');

describe('managed ChatGPT route cutover', () => {
  it('stops an active legacy PTY before setup and resumes only with the saved route', () => {
    expect(mainSource).toContain('防止登录期间继续消耗原中转站额度');
    expect(mainSource).toMatch(
      /const resumeAfterSetup = runtime\.isActive\(validatedSessionId\);[\s\S]*?workspace\.stop\(validatedSessionId\);[\s\S]*?runtime\.setInactive\(validatedSessionId\);/,
    );
    expect(mainSource).toMatch(
      /const resumeClaudeAfterManagedCutover[\s\S]*?prepareLaunch\(sessionId, cwd, 'continue'\)[\s\S]*?workspace\.restart\(sessionId, prepared\.environment\)/,
    );
    expect(mainSource).toContain('旧路由会话已保持停止，不会继续消耗原中转站额度');
  });
});
