import type { ClaudePluginCatalog, SoftwareUpdateState } from '../contracts';

export type SoftwareUpdateAction = 'hidden' | 'install' | 'update';

export interface UpdateActionState {
  application: boolean;
  claudeCode: SoftwareUpdateAction;
  plugins: boolean;
  router: SoftwareUpdateAction;
  totalAvailable: number;
}

const softwareAction = (
  target: SoftwareUpdateState['claudeCode'] | undefined,
): SoftwareUpdateAction => {
  if (!target) {
    return 'hidden';
  }
  if (!target.installed) {
    return 'install';
  }
  return target.updateAvailable ? 'update' : 'hidden';
};

/**
 * Keeps update actions out of the initial UI. Installation remains available when software is
 * missing, while an installed target only gets an action after a completed check reports an update.
 */
export const deriveUpdateActionState = (
  software: SoftwareUpdateState | undefined,
  plugins: ClaudePluginCatalog | undefined,
): UpdateActionState => ({
  application: software?.application.updateAvailable ?? false,
  claudeCode: softwareAction(software?.claudeCode),
  plugins: (plugins?.updatesAvailable ?? 0) > 0,
  router: softwareAction(software?.router),
  totalAvailable:
    Number(software?.application.updateAvailable ?? false) +
    Number(software?.claudeCode.updateAvailable ?? false) +
    Number(software?.router.updateAvailable ?? false) +
    (plugins?.updatesAvailable ?? 0),
});
