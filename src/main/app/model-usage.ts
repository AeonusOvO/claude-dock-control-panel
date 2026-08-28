import type { Registry } from '../infra/registry';
import {
  CLAUDE_RUNTIME,
  CODEX_RUNTIME,
  MAIN_WINDOW,
  MANAGED_CHATGPT_GATEWAY,
  MODEL_USAGE_SERVICE,
  MODEL_USAGE_WINDOW,
} from '../infra/service-tokens';
import { CHANNELS } from '../../shared/ipc/channels';
import type { TerminalThemeId } from '../../shared/ui/terminal-themes';
import { ModelUsageService } from '../usage/service';
import type { RuntimeProfile } from './profile';
import { ModelUsageWindow } from './model-usage-window';

export const installModelUsage = (
  services: Registry,
  profile: RuntimeProfile,
  themeId: TerminalThemeId,
): void => {
  services.register(
    MODEL_USAGE_WINDOW,
    () =>
      new ModelUsageWindow((visible) => services.resolve(MODEL_USAGE_SERVICE).setFloating(visible)),
  );
  services.register(
    MODEL_USAGE_SERVICE,
    () =>
      new ModelUsageService({
        projectsRoot: profile.paths.projects,
        userDataPath: profile.paths.userData,
        themeId,
        onChanged: (snapshot) => {
          const main = services.resolve(MAIN_WINDOW).current;
          if (main && !main.isDestroyed())
            main.webContents.send(CHANNELS.MODEL_USAGE_CHANGED, snapshot);
          services.resolve(MODEL_USAGE_WINDOW).publish(snapshot);
        },
        readChatGptQuota: async () => {
          if (!profile.effects.allowRealRuntimes) return undefined;
          const gateway = services.resolve(MANAGED_CHATGPT_GATEWAY);
          const account = await gateway.getUsageAccountIdentity();
          if (!account) return undefined;
          const quota = await services.resolve(CODEX_RUNTIME).readAccountResourceUsage(account);
          return account === (await gateway.getUsageAccountIdentity()) ? quota : undefined;
        },
      }),
  );
  const usage = services.resolve(MODEL_USAGE_SERVICE);
  services.resolve(CLAUDE_RUNTIME).setModelUsageObserver({
    capture: (connection) => usage.capture(connection),
    select: (connection, reset) => usage.select(connection, reset),
    observe: (connection, cwd, sessionId, metrics) =>
      usage.observe(connection, cwd, sessionId, metrics),
  });
};
