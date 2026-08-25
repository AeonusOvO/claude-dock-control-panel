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
        autoLoadLastConversationModelOnStartup: true,
        autoLoadLastConversationOnStartup: false,
        modelMismatchBehavior: 'use-current',
      },
    });

    harness.click('#open-connection-advanced');
    await harness.flush();

    const modelChoice = harness.query<HTMLSelectElement>('#settings-conversation-model-mismatch');
    const modelChoiceLabel = modelChoice
      .closest('.select')
      ?.querySelector<HTMLElement>('.select__label');
    const autoLoadConversation = harness.query<HTMLInputElement>(
      '#settings-auto-load-last-conversation',
    );
    const autoLoadModel = harness.query<HTMLInputElement>(
      '#settings-auto-load-last-conversation-model',
    );
    expect(modelChoice.value).toBe('use-current');
    expect(modelChoiceLabel?.textContent).toBe('始终使用当前模型');
    expect(autoLoadConversation.checked).toBe(false);
    expect(autoLoadModel.checked).toBe(true);

    modelChoice.value = 'use-conversation';
    modelChoice.dispatchEvent(new Event('change', { bubbles: true }));
    autoLoadConversation.checked = true;
    autoLoadConversation.dispatchEvent(new Event('change', { bubbles: true }));
    autoLoadModel.checked = false;
    autoLoadModel.dispatchEvent(new Event('change', { bubbles: true }));
    expect(modelChoiceLabel?.textContent).toBe('始终使用对话原有模型');
    expect(harness.query('#settings-unsaved-indicator').textContent).toBe('*3 项未保存');

    harness.click('#complete-connection-advanced');
    await harness.flush();
    expect(harness.method('setConversationResumePreferences')).toHaveBeenCalledExactlyOnceWith({
      autoLoadLastConversationModelOnStartup: false,
      autoLoadLastConversationOnStartup: true,
      modelMismatchBehavior: 'use-conversation',
    });
  });
});
