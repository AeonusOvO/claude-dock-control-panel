import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceStore } from '../src/main/workspace-store';

const fixtureRoots: string[] = [];

afterEach(() => {
  for (const fixtureRoot of fixtureRoots.splice(0)) {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});

const createStore = (): { fixtureRoot: string; store: WorkspaceStore } => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'claudedock-workspace-'));
  fixtureRoots.push(fixtureRoot);
  return { fixtureRoot, store: new WorkspaceStore(fixtureRoot) };
};

describe('WorkspaceStore', () => {
  it('persists projects without duplicating case-insensitive Windows paths', () => {
    const { store } = createStore();

    store.addProject('D:\\Projects\\Example');
    store.addProject('d:\\projects\\example');

    expect(store.getProjects()).toHaveLength(1);
    expect(store.getLastActiveProject()).toBe('d:\\projects\\example');
  });

  it('tracks activation and chooses a remaining project when one is removed', () => {
    const { store } = createStore();
    store.addProject('D:\\Projects\\One');
    store.addProject('D:\\Projects\\Two');
    store.updateLastActive('D:\\Projects\\One');

    expect(store.getLastActiveProject()).toBe('D:\\Projects\\One');

    store.removeProject('D:\\Projects\\One');

    expect(store.getProjects().map((project) => project.path)).toEqual(['D:\\Projects\\Two']);
    expect(store.getLastActiveProject()).toBe('D:\\Projects\\Two');
  });

  it('fails closed to an empty workspace when the store is malformed', () => {
    const { fixtureRoot, store } = createStore();
    const storageDirectory = path.join(fixtureRoot, 'claude');
    mkdirSync(storageDirectory, { recursive: true });
    writeFileSync(path.join(storageDirectory, 'workspace.json'), '{broken', 'utf8');

    expect(store.getProjects()).toEqual([]);
    expect(store.getLastActiveProject()).toBeUndefined();
  });
});
