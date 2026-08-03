import { describe, expect, it } from 'vitest';
import { localizePluginCopy } from '../src/shared/plugin-localization';

describe('plugin localization', () => {
  it('keeps a Chinese description and classifies it', () => {
    const copy = localizePluginCopy({
      description: '用于 API 安全检查与漏洞发现。',
      marketplaceName: 'official',
      name: 'api-security',
    });

    expect(copy.description).toContain('安全检查');
    expect(copy.originalDescription).toBeUndefined();
  });

  it('generates Chinese primary copy while preserving the English source', () => {
    const copy = localizePluginCopy({
      description: 'Automate API security testing and detect OWASP vulnerabilities.',
      marketplaceName: 'official',
      name: 'api-security',
    });

    expect(copy.category).toBe('安全与合规');
    expect(copy.description).toContain('安全检查与漏洞发现');
    expect(copy.description).toContain('API 设计、调试与文档处理');
    expect(copy.originalDescription).toContain('Automate API');
  });
});
