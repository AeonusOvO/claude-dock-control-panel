import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentRuntimeStore } from '../../src/main/runtime/store';

const fixtureRoots: string[] = [];

afterEach(() => {
  for (const fixtureRoot of fixtureRoots.splice(0)) {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});

const createStore = () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'claudedock-agent-runtime-'));
  fixtureRoots.push(fixtureRoot);
  return {
    fixtureRoot,
    storagePath: path.join(fixtureRoot, 'claude', 'agent-runtimes.json'),
    store: new AgentRuntimeStore(fixtureRoot),
  };
};

describe('AgentRuntimeStore', () => {
  it('defaults to Claude and persists a project-scoped Codex selection', () => {
    const { fixtureRoot, storagePath, store } = createStore();
    const project = path.join(fixtureRoot, 'My Project');

    expect(store.get(project)).toBe('claude');
    store.set(project, 'codex');

    expect(store.get(project.toUpperCase())).toBe('codex');
    expect(new AgentRuntimeStore(fixtureRoot).get(project)).toBe('codex');
    expect(readFileSync(storagePath, 'utf8')).toContain('"codex"');
  });

  it('persists one global next-conversation engine without changing legacy project values', () => {
    const { fixtureRoot, store } = createStore();
    const project = path.join(fixtureRoot, 'My Project');
    store.set(project, 'claude');

    expect(store.getNext()).toBe('claude');
    store.setNext('codex');

    expect(store.get(project)).toBe('claude');
    expect(store.getNext()).toBe('codex');
    expect(new AgentRuntimeStore(fixtureRoot).getNext()).toBe('codex');
  });

  it('removes only the selected project and tolerates a corrupt store', () => {
    const { fixtureRoot, storagePath, store } = createStore();
    const first = path.join(fixtureRoot, 'first');
    const second = path.join(fixtureRoot, 'second');
    store.set(first, 'codex');
    store.set(second, 'codex');

    store.remove(first);

    expect(store.get(first)).toBe('claude');
    expect(store.get(second)).toBe('codex');
    writeFileSync(storagePath, '{broken', 'utf8');
    expect(new AgentRuntimeStore(fixtureRoot).get(second)).toBe('claude');
  });
});
