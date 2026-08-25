import { afterEach, describe, expect, it } from 'vitest';
import { createRendererHarness, type RendererHarness } from '../helpers/renderer-harness';

describe('conversation resume settings', () => {
  let harness: RendererHarness | undefined;

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('syncs the themed selector and saves model plus startup choices together', async () => {
    harness = await createRendererHarness();
    const initial = await harness.api.getAppSettings();
    harness.method('getAppSettings').mockResolvedValue({
      ...initial,
      conversationResume: {
        modelMismatchBehavior: 'use-current',
        restoreLastWorkspaceOnStartup: false,
      },
    });

    harness.click('#open-connection-advanced');
    await harness.flush();

    const modelChoice = harness.query<HTMLSelectElement>('#settings-conversation-model-mismatch');
    const modelChoiceLabel = modelChoice
      .closest('.select')
      ?.querySelector<HTMLElement>('.select__label');
    const restoreLastWorkspace = harness.query<HTMLInputElement>(
      '#settings-restore-last-workspace',
    );
    expect(modelChoice.value).toBe('use-current');
    expect(modelChoiceLabel?.textContent).toBe('始终使用当前模型');
    expect(restoreLastWorkspace.checked).toBe(false);

    modelChoice.value = 'use-conversation';
    modelChoice.dispatchEvent(new Event('change', { bubbles: true }));
    restoreLastWorkspace.checked = true;
    restoreLastWorkspace.dispatchEvent(new Event('change', { bubbles: true }));
    expect(modelChoiceLabel?.textContent).toBe('始终使用对话原有模型');
    expect(harness.query('#settings-unsaved-indicator').textContent).toBe('*2 项未保存');

    harness.click('#complete-connection-advanced');
    await harness.flush();
    expect(harness.method('setConversationResumePreferences')).toHaveBeenCalledExactlyOnceWith({
      modelMismatchBehavior: 'use-conversation',
      restoreLastWorkspaceOnStartup: true,
    });
  });
});
