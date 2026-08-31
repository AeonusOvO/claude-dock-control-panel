import type { Registry } from '../infra/registry';
import {
  CLAUDE_RUNTIME,
  MAIN_WINDOW,
  MANAGED_CHATGPT_GATEWAY,
  MODEL_USAGE_SERVICE,
  MODEL_USAGE_WINDOW,
} from '../infra/service-tokens';
import { CHANNELS } from '../../shared/ipc/channels';
import type { TerminalThemeId } from '../../shared/ui/terminal-themes';
import { ModelUsageService } from '../usage/service';
import type { AppPreferencesStore } from '../stores/app-preferences';
import type { RuntimeProfile } from './profile';
import { ModelUsageWindow } from './model-usage-window';

export const installModelUsage = (
  services: Registry,
  profile: RuntimeProfile,
  themeId: TerminalThemeId,
  appPreferencesStore: Pick<AppPreferencesStore, 'get' | 'set'>,
): void => {
  let pendingRequestedVisibility: boolean | undefined;
  let restoringVisibility = false;
  const persistVisibility = (visible: boolean): void => {
    appPreferencesStore.set({ modelUsageFloatingVisible: visible });
  };
  const requestVisibility = (visible: boolean): void => {
    if (restoringVisibility) return;
    persistVisibility(visible);
    pendingRequestedVisibility = visible;
  };
  const handleVisibility = (visible: boolean): void => {
    const requested = pendingRequestedVisibility;
    pendingRequestedVisibility = undefined;
    services.resolve(MODEL_USAGE_SERVICE).setFloating(visible);
    if (!visible && requested !== false) {
      try {
        // A native close is an explicit hide; shutdown destruction is suppressed by the window guard.
        persistVisibility(false);
      } catch {
        // Keep the in-memory state accurate even if the preference store is unavailable.
      }
    }
  };
  services.register(
    MODEL_USAGE_WINDOW,
    () => new ModelUsageWindow(handleVisibility, requestVisibility),
  );
  services.register(MODEL_USAGE_SERVICE, () => {
    const gateway = profile.effects.allowRealRuntimes
      ? services.resolve(MANAGED_CHATGPT_GATEWAY)
      : undefined;
    return new ModelUsageService({
      projectsRoot: profile.paths.projects,
      userDataPath: profile.paths.userData,
      themeId,
      onChanged: (snapshot) => {
        const main = services.resolve(MAIN_WINDOW).current;
        if (main && !main.isDestroyed())
          main.webContents.send(CHANNELS.MODEL_USAGE_CHANGED, snapshot);
        services.resolve(MODEL_USAGE_WINDOW).publish(snapshot);
      },
      readChatGptQuota: async (signal, model) => gateway?.readAccountResourceUsage(model, signal),
      subscribeChatGptQuotaInvalidated: gateway
        ? (listener) => gateway.onQuotaInvalidated((kind) => listener(kind === 'account'))
        : undefined,
      subscribeChatGptQuotaReadable: gateway
        ? (listener) => gateway.onQuotaReadable(listener)
        : undefined,
    });
  });
  const usage = services.resolve(MODEL_USAGE_SERVICE);
  services.resolve(CLAUDE_RUNTIME).setModelUsageObserver({
    capture: (connection) => usage.capture(connection),
    select: (connection, reset) => usage.select(connection, reset),
    observe: (connection, cwd, sessionId, metrics) =>
      usage.observe(connection, cwd, sessionId, metrics),
  });

  if (appPreferencesStore.get().modelUsageFloatingVisible) {
    restoringVisibility = true;
    void services
      .resolve(MODEL_USAGE_WINDOW)
      .setVisible(true)
      .catch(() => {
        // Keep the remembered preference so the next startup can retry the widget.
      })
      .finally(() => {
        restoringVisibility = false;
      });
  }
};
