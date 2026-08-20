import { requiredElement } from '../platform/dom';

export interface ToastShell {
  showToast: (message: string, tone?: 'error' | 'success') => void;
}

export const createToastShell = (): ToastShell => {
  const toast = requiredElement<HTMLElement>('#toast');
  let toastTimer: number | undefined;

  const showToast = (message: string, tone: 'error' | 'success' = 'success'): void => {
    window.clearTimeout(toastTimer);
    toast.textContent =
      tone === 'error' && !/[\u3400-\u9fff]/u.test(message)
        ? '操作失败；请查看终端输出或日志了解详情。'
        : message;
    toast.dataset.tone = tone;
    toast.classList.add('toast--visible');
    toastTimer = window.setTimeout(() => {
      toast.classList.remove('toast--visible');
    }, 3200);
  };

  return { showToast };
};
