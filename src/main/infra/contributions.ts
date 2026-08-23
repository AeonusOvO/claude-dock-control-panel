export type IpcDomainContribution<Dependencies extends object> = (
  dependencies: Dependencies,
) => void;

export type StartupContribution = () => void | Promise<void>;

export type QuitContribution = () => void;

export type TrayMenuItemContribution<Context, Item> = (context: Context) => readonly Item[];

export const runIpcDomainContributions = <Dependencies extends object>(
  dependencies: Dependencies,
  contributions: readonly IpcDomainContribution<Dependencies>[],
): void => {
  for (const contribution of contributions) {
    contribution(dependencies);
  }
};

export const runStartupContributions = async (
  contributions: readonly StartupContribution[],
): Promise<void> => {
  for (const contribution of contributions) {
    await contribution();
  }
};

/**
 * Runs every teardown step, even when one of them throws.
 *
 * Quit contributions are independent cleanups, and the last of them is what force-kills the
 * PowerShell trees ConPTY's own `kill()` cannot reach. Without per-step isolation, one throwing
 * contribution would skip all the later ones and leave those shells running after the app is gone —
 * so a failure is recorded and the sweep continues. Errors are collected rather than logged here to
 * keep this module free of infrastructure imports; the caller decides how to report them.
 */
export const runQuitContributions = (contributions: readonly QuitContribution[]): unknown[] => {
  const failures: unknown[] = [];
  for (const contribution of contributions) {
    try {
      contribution();
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
};

export const collectTrayMenuItems = <Context, Item>(
  context: Context,
  contributions: readonly TrayMenuItemContribution<Context, Item>[],
): Item[] => {
  const items: Item[] = [];
  for (const contribution of contributions) {
    items.push(...contribution(context));
  }
  return items;
};
