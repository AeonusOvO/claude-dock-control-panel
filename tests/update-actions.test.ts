import { describe, expect, it } from 'vitest';
import type { ClaudePluginCatalog, SoftwareUpdateState } from '../src/shared/contracts';
import { deriveUpdateActionState } from '../src/shared/update-actions';

const softwareState = (
  claudeInstalled: boolean,
  claudeUpdate: boolean,
  routerInstalled: boolean,
  routerUpdate: boolean,
): SoftwareUpdateState => ({
  application: { installed: true, message: '', updateAvailable: false },
  checkedAt: 1,
  claudeCode: {
    installed: claudeInstalled,
    message: '',
    updateAvailable: claudeUpdate,
  },
  router: {
    installed: routerInstalled,
    message: '',
    updateAvailable: routerUpdate,
  },
});

const pluginCatalog = (updatesAvailable: number): ClaudePluginCatalog => ({
  available: [],
  checkedAt: 1,
  cliAvailable: true,
  installed: [],
  marketplaces: [],
  message: '',
  updatesAvailable,
});

describe('conditional update actions', () => {
  it('hides every update action before the first background check completes', () => {
    expect(deriveUpdateActionState(undefined, undefined)).toEqual({
      application: false,
      claudeCode: 'hidden',
      plugins: false,
      router: 'hidden',
      totalAvailable: 0,
    });
  });

  it('keeps install actions available without presenting them as updates', () => {
    expect(
      deriveUpdateActionState(softwareState(false, false, false, false), pluginCatalog(0)),
    ).toEqual({
      application: false,
      claudeCode: 'install',
      plugins: false,
      router: 'install',
      totalAvailable: 0,
    });
  });

  it('keeps installed targets hidden when the completed check finds no update', () => {
    expect(
      deriveUpdateActionState(softwareState(true, false, true, false), pluginCatalog(0)),
    ).toEqual({
      application: false,
      claudeCode: 'hidden',
      plugins: false,
      router: 'hidden',
      totalAvailable: 0,
    });
  });

  it('only exposes update actions for targets with detected updates', () => {
    expect(
      deriveUpdateActionState(softwareState(true, true, true, false), pluginCatalog(3)),
    ).toEqual({
      application: false,
      claudeCode: 'update',
      plugins: true,
      router: 'hidden',
      totalAvailable: 4,
    });
  });

  it('counts an application release without inventing an in-app install action', () => {
    const state = softwareState(true, false, true, false);
    state.application.updateAvailable = true;
    expect(deriveUpdateActionState(state, pluginCatalog(0))).toEqual({
      application: true,
      claudeCode: 'hidden',
      plugins: false,
      router: 'hidden',
      totalAvailable: 1,
    });
  });
});
