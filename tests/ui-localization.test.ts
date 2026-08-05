import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const rendererHtml = readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8');
const rendererSource = readFileSync(new URL('../src/renderer/main.ts', import.meta.url), 'utf8');

describe('Chinese interface contract', () => {
  it('enables the xterm proposed API required by the Unicode 11 addon', () => {
    expect(rendererSource).toContain('allowProposedApi: true');
    expect(rendererSource).not.toContain('allowProposedApi: false');
  });

  it('uses Chinese labels for user-facing terminal and connection controls', () => {
    expect(rendererHtml).toContain('项目终端控制台');
    expect(rendererHtml).toContain('服务提供方配置');
    expect(rendererHtml).toContain('输入令牌');
    expect(rendererHtml).toContain('会话编号');

    for (const deprecatedCopy of [
      'PowerShell Control',
      'OpenAI Chat Completions',
      'OpenAI Responses',
      'Anthropic Messages',
      'Provider 配置',
      '输入 token',
      '输出 token',
      '会话 ID',
      'Hooks 检查',
      '启动 Router',
    ]) {
      expect(rendererHtml).not.toContain(deprecatedCopy);
    }
  });

  it('shows localized plugin summaries without exposing an English-original panel', () => {
    expect(rendererSource).not.toContain('查看英文原文');
    expect(rendererSource).not.toContain('plugin-card__original');
    expect(rendererSource).not.toContain('localized.originalDescription');
  });

  it('keeps quit protection actions and severity copy in Chinese', () => {
    for (const copy of [
      '有操作正在进行，不建议退出',
      '还有后台任务未完成',
      '确认退出 ClaudeDock？',
      '可以直接关闭窗口，后台会继续运行。',
      '最小化到托盘，继续运行',
      '仍要退出',
    ]) {
      expect(`${rendererHtml}\n${rendererSource}`).toContain(copy);
    }
  });
});
