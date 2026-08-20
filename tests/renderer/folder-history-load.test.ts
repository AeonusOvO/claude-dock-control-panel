import { describe, expect, it } from 'vitest';
import { FolderHistoryLoadCoordinator } from '../../src/renderer/features/projects/folder-history-load';

describe('FolderHistoryLoadCoordinator', () => {
  it('queues one forced reload behind the current project read', () => {
    const coordinator = new FolderHistoryLoadCoordinator();
    const current = coordinator.request('d:\\project alpha', false);

    expect(current).toBeDefined();
    expect(coordinator.request('d:\\project alpha', false)).toBeUndefined();
    expect(coordinator.request('d:\\project alpha', true)).toBeUndefined();
    expect(coordinator.request('d:\\project alpha', true)).toBeUndefined();
    expect(coordinator.finish(current!)).toEqual({ current: true, reloadRequested: true });

    const replacement = coordinator.request('d:\\project alpha', true);
    expect(replacement?.generation).toBeGreaterThan(current!.generation);
    expect(coordinator.finish(replacement!)).toEqual({ current: true, reloadRequested: false });
  });

  it('prevents a forgotten project read from applying to or clearing a later re-add', () => {
    const coordinator = new FolderHistoryLoadCoordinator();
    const forgotten = coordinator.request('d:\\project alpha', false)!;

    expect(coordinator.invalidate('d:\\project alpha')).toEqual(forgotten);
    const readded = coordinator.request('d:\\project alpha', false)!;

    expect(coordinator.isCurrent(forgotten)).toBe(false);
    expect(coordinator.isCurrent(readded)).toBe(true);
    expect(coordinator.finish(forgotten)).toEqual({ current: false, reloadRequested: false });
    expect(coordinator.isCurrent(readded)).toBe(true);
    expect(coordinator.finish(readded)).toEqual({ current: true, reloadRequested: false });
  });

  it('drops queued reload ownership when the project is invalidated', () => {
    const coordinator = new FolderHistoryLoadCoordinator();
    const current = coordinator.request('d:\\project alpha', false)!;
    coordinator.request('d:\\project alpha', true);

    coordinator.invalidate('d:\\project alpha');

    expect(coordinator.finish(current)).toEqual({ current: false, reloadRequested: false });
    const readded = coordinator.request('d:\\project alpha', false)!;
    expect(coordinator.finish(readded)).toEqual({ current: true, reloadRequested: false });
  });

  it('remembers a failed read so it is never mistaken for an empty history', () => {
    const coordinator = new FolderHistoryLoadCoordinator();
    const attempt = coordinator.request('d:\\project alpha', false)!;

    coordinator.finish(attempt);
    coordinator.markFailed('d:\\project alpha');

    // Caching a failure as `[]` would make every later non-forced read short-circuit and show the
    // folder as permanently empty, so the failure has to stay distinguishable and retryable.
    expect(coordinator.hasFailed('d:\\project alpha')).toBe(true);
    expect(coordinator.hasFailed('d:\\project beta')).toBe(false);

    const retry = coordinator.request('d:\\project alpha', true)!;
    coordinator.finish(retry);
    coordinator.markLoaded('d:\\project alpha');

    expect(coordinator.hasFailed('d:\\project alpha')).toBe(false);
  });

  it('forgets failure state when the project leaves the workspace', () => {
    const coordinator = new FolderHistoryLoadCoordinator();

    coordinator.markFailed('d:\\project alpha');
    coordinator.invalidate('d:\\project alpha');

    expect(coordinator.hasFailed('d:\\project alpha')).toBe(false);
  });
});
