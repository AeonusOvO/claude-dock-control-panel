import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const serviceSource = readFileSync(
  path.join(__dirname, '..', 'src', 'main', 'chat-service.ts'),
  'utf8',
);
const contractsSource = readFileSync(
  path.join(__dirname, '..', 'src', 'shared', 'contracts.ts'),
  'utf8',
);

describe('independent chat timeout invariants', () => {
  it('has no total-duration timer that can cut off a healthy stream', () => {
    expect(serviceSource).not.toContain('REQUEST_TOTAL_TIMEOUT_MS');
    expect(serviceSource).not.toContain('totalTimeoutMs');
    expect(serviceSource).not.toMatch(/totalTimeout\s*=\s*setTimeout/);
  });

  it("never uses the legacy 'timeout' abort reason", () => {
    expect(serviceSource).not.toMatch(/abortReason\s*=\s*['"]timeout['"]/);
    expect(serviceSource).not.toMatch(/controller\.abort\(\s*['"]timeout['"]\s*\)/);
    expect(contractsSource).not.toMatch(/abortReason\??:[^;]*['"]timeout['"]/);
  });

  it('keeps idle handling non-destructive by default and enables TCP keepalive', () => {
    expect(serviceSource).toMatch(/readHardIdleTimeoutMs:[\s\S]*?=\s*\(\)\s*=>\s*0/);
    expect(serviceSource).toMatch(/type:\s*['"]idle['"]/);
    expect(serviceSource).toMatch(/keepalive:\s*true/);
    expect(serviceSource).toMatch(
      /hardIdleTimeoutMs\s*>\s*0[\s\S]*?controller\.abort\(['"]local-timeout['"]\)/,
    );
  });
});
