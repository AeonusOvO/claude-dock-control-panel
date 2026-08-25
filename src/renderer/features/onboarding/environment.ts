import type { OnboardingElements } from './elements';
import type { OnboardingMutableState } from './state';

export const scanOnboardingEnvironment = async (
  elements: OnboardingElements,
  state: OnboardingMutableState,
): Promise<void> => {
  const generation = ++state.scanGeneration;
  elements.checklist.setAttribute('aria-busy', 'true');
  elements.recheckButton.disabled = true;
  elements.toolCheck.dataset.tone = 'checking';
  elements.toolStatus.textContent = '检测中';
  elements.prepareHint.textContent = '正在读取本机状态…';
  if (state.engine === 'codex') {
    elements.toolTitle.textContent = 'Codex CLI';
    elements.toolDetail.textContent = '选择项目后检测 CLI、账号与项目配置';
    elements.toolStatus.textContent = '项目后检测';
    elements.toolCheck.dataset.tone = 'automatic';
    elements.prepareHint.textContent = 'Codex 的项目级检测将在下一步继续';
    elements.checklist.setAttribute('aria-busy', 'false');
    elements.recheckButton.disabled = false;
    return;
  }
  elements.toolTitle.textContent = 'Claude Code';
  try {
    const updates = await window.controlPanel.getSoftwareUpdates(false);
    if (generation !== state.scanGeneration) return;
    const target = updates.claudeCode;
    elements.toolDetail.textContent = target.message;
    elements.toolStatus.textContent = target.installed
      ? target.updateAvailable
        ? '可更新'
        : '已安装'
      : '待安装';
    elements.toolCheck.dataset.tone = target.installed ? 'ready' : 'warning';
    elements.prepareHint.textContent = target.installed
      ? '本机工具已检测；项目级接入将在下一步继续'
      : '打开项目后，自动接入流程会补齐缺少的组件';
  } catch {
    if (generation !== state.scanGeneration) return;
    elements.toolDetail.textContent = '暂时无法读取版本；可继续，稍后在接入页重试';
    elements.toolStatus.textContent = '稍后重试';
    elements.toolCheck.dataset.tone = 'warning';
    elements.prepareHint.textContent = '检测未完成，但不会把未知状态显示为成功';
  } finally {
    if (generation === state.scanGeneration) {
      elements.checklist.setAttribute('aria-busy', 'false');
      elements.recheckButton.disabled = false;
    }
  }
};
