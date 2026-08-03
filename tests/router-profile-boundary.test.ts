import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const routerSource = readFileSync(
  new URL('../src/main/claude-router-manager.ts', import.meta.url),
  'utf8',
);

describe('CCR CLI-only profile boundary', () => {
  it('has one saveConfig gateway and forces desktop profile takeover off', () => {
    expect(routerSource.match(/'saveConfig'/g)).toHaveLength(1);
    expect(routerSource.match(/applyProfile:\s*false/g)).toHaveLength(1);
    expect(routerSource).not.toContain(['applyProfile', 'true'].join(': '));
    expect(routerSource).toMatch(
      /private saveConfigWithoutProfileTakeover\([\s\S]*?'saveConfig',[\s\S]*?applyProfile:\s*false/,
    );
  });

  it('treats historical takeover artifacts as purge-list names only', () => {
    const withoutPurgeInventory = routerSource.replace(
      /const ROUTER_DATA_ENTRIES[\s\S]*?\] as const;/,
      '',
    );
    expect(withoutPurgeInventory).not.toContain('claude-app-gateway-backup.json');
    expect(withoutPurgeInventory).not.toContain('global-profile-takeover.json');
  });

  it('never references the Claude Desktop configuration file', () => {
    expect(routerSource.toLowerCase()).not.toContain(
      ['claude', 'desktop', 'config.json'].join('_'),
    );
  });
});
