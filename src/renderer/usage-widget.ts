import { SHELL_CSS_VARIABLES, TERMINAL_THEMES } from '../shared/ui/terminal-themes';
import { renderModelUsage, subscribeModelUsage } from './platform/model-usage-view';

const root = document.querySelector<HTMLElement>('#usage-ball')!;
const api = window.modelUsage;
const unsubscribe = subscribeModelUsage(
  api,
  (snapshot) => {
    const theme = TERMINAL_THEMES[snapshot.themeId];
    for (const [key, variable] of Object.entries(SHELL_CSS_VARIABLES)) {
      document.documentElement.style.setProperty(
        variable,
        theme.shell[key as keyof typeof theme.shell],
      );
    }
    document.documentElement.dataset.appearance = theme.appearance;
    renderModelUsage(root, snapshot);
  },
  () => {
    root.querySelector('[data-usage-value]')!.textContent = '暂无法获取';
  },
);
document.querySelector('#close-usage-ball')!.addEventListener('click', () => {
  void api.setModelUsageFloating(false).catch(() => {
    root.title = '关闭失败，请稍后重试';
  });
});
window.addEventListener('beforeunload', unsubscribe, { once: true });
