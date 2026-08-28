import type { ModelUsageApi, ModelUsageSnapshot } from '../../shared/contracts';
import { renderModelUsage, subscribeModelUsage } from '../platform/model-usage-view';

export const installModelUsageCard = (
  api: ModelUsageApi,
  showError: (message: string) => void,
): (() => void) => {
  const card = document.querySelector<HTMLElement>('#model-usage');
  const button = document.querySelector<HTMLButtonElement>('#model-usage-floating');
  if (!card || !button) return () => {};
  let state: ModelUsageSnapshot | undefined;
  let busy = false;
  const unsubscribe = subscribeModelUsage(
    api,
    (snapshot) => {
      state = snapshot;
      renderModelUsage(card, snapshot);
      button.setAttribute('aria-pressed', String(snapshot.floating));
      button.title = snapshot.floating ? '关闭悬浮球' : '打开置顶悬浮球';
      button.setAttribute('aria-label', button.title);
    },
    () => {
      card.querySelector('[data-usage-value]')!.textContent = '暂无法获取';
    },
  );
  const toggle = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    button.disabled = true;
    try {
      await api.setModelUsageFloating(!state?.floating);
    } catch {
      showError('悬浮球未能打开，请稍后重试。');
    } finally {
      busy = false;
      button.disabled = false;
    }
  };
  button.addEventListener('click', toggle);
  return () => {
    unsubscribe();
    button.removeEventListener('click', toggle);
  };
};
