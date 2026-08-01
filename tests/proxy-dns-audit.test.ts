import { describe, expect, it } from 'vitest';
import { evaluateDns } from '../src/main/proxy/leak-audit';

describe('proxy DNS audit', () => {
  it('flags private system resolvers while explaining HTTP CONNECT remote resolution', () => {
    const item = evaluateDns(['192.168.1.1', '1.1.1.1'], true);
    expect(item.verdict).toBe('warning');
    expect(item.evidence.join(' ')).toContain('HTTP CONNECT');
    expect(item.explanation).toContain('远端解析');
  });

  it('passes when online evidence and local facts show no resolver leak', () => {
    expect(evaluateDns(['1.1.1.1'], true, []).verdict).toBe('passed');
  });

  it('does not claim safety when the optional online probe is unavailable', () => {
    const item = evaluateDns(['1.1.1.1'], true);
    expect(item.verdict).toBe('warning');
    expect(item.evidence).toContain('在线探测不可用，仅采用本地判据');
  });
});
