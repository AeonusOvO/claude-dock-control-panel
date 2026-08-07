import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelSpeedPreferencesStore } from '../src/main/model-speed-preferences-store';

const fixtureRoots: string[] = [];

const createFixture = (): { root: string; store: ModelSpeedPreferencesStore } => {
  const root = mkdtempSync(path.join(tmpdir(), 'claudedock-model-speed-'));
  fixtureRoots.push(root);
  return { root, store: new ModelSpeedPreferencesStore(root) };
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe('model speed preferences store', () => {
  it('defaults to standard and persists explicit choices independently', () => {
    const { root, store } = createFixture();
    const opus = 'a'.repeat(64);
    const gpt = 'b'.repeat(64);
    expect(store.get(opus)).toEqual({ mode: 'standard', source: 'default' });
    expect(store.set(opus, 'fast')).toEqual({ mode: 'fast', source: 'user' });
    expect(store.set(gpt, 'standard')).toEqual({ mode: 'standard', source: 'user' });

    const reloaded = new ModelSpeedPreferencesStore(root);
    expect(reloaded.get(opus)).toEqual({ mode: 'fast', source: 'user' });
    expect(reloaded.get(gpt)).toEqual({ mode: 'standard', source: 'user' });
  });

  it('treats malformed or unsupported files as an empty store', () => {
    const { root } = createFixture();
    const directory = path.join(root, 'claude');
    const storagePath = path.join(directory, 'model-speed-preferences.json');
    mkdirSync(directory, { recursive: true });
    writeFileSync(storagePath, '{broken', 'utf8');
    expect(new ModelSpeedPreferencesStore(root).get('a'.repeat(64))).toEqual({
      mode: 'standard',
      source: 'default',
    });

    writeFileSync(storagePath, JSON.stringify({ entries: {}, version: 2 }), 'utf8');
    expect(new ModelSpeedPreferencesStore(root).get('a'.repeat(64))).toEqual({
      mode: 'standard',
      source: 'default',
    });
  });

  it('rejects invalid target keys and never stores route credentials', () => {
    const { root, store } = createFixture();
    expect(() => store.set('not-a-target-key', 'fast')).toThrow('模型速度偏好无效');
    store.set('c'.repeat(64), 'fast');
    const raw = readFileSync(path.join(root, 'claude', 'model-speed-preferences.json'), 'utf8');
    expect(raw).not.toContain('apiKey');
    expect(raw).not.toContain('token');
  });

  it('keeps only the newest 400 entries', () => {
    const { root, store } = createFixture();
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    for (let index = 0; index < 401; index += 1) {
      store.set(index.toString(16).padStart(64, '0'), index % 2 === 0 ? 'fast' : 'standard');
    }
    const parsed = JSON.parse(
      readFileSync(path.join(root, 'claude', 'model-speed-preferences.json'), 'utf8'),
    ) as { entries: Record<string, unknown> };
    expect(Object.keys(parsed.entries)).toHaveLength(400);
    expect(parsed.entries['0'.repeat(64)]).toBeUndefined();
    expect(parsed.entries[(400).toString(16).padStart(64, '0')]).toBeDefined();
  });
});
