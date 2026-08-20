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

export const runQuitContributions = (contributions: readonly QuitContribution[]): void => {
  for (const contribution of contributions) {
    contribution();
  }
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
