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
        startupModelConnectCancelAfterMinutes: 2,
        startupModelConnectForceStopAfterMinutes: 5,
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
    const cancelAfter = harness.query<HTMLInputElement>(
      '#settings-startup-model-connect-cancel-after',
    );
    const forceStopAfter = harness.query<HTMLInputElement>(
      '#settings-startup-model-connect-force-stop-after',
    );
    expect(modelChoice.value).toBe('use-current');
    expect(modelChoiceLabel?.textContent).toBe('始终使用当前模型');
    expect(autoLoadConversation.checked).toBe(false);
    expect(autoLoadModel.checked).toBe(true);
    expect(cancelAfter.value).toBe('2');
    expect(forceStopAfter.value).toBe('5');

    modelChoice.value = 'use-conversation';
    modelChoice.dispatchEvent(new Event('change', { bubbles: true }));
    autoLoadConversation.checked = true;
    autoLoadConversation.dispatchEvent(new Event('change', { bubbles: true }));
    autoLoadModel.checked = false;
    autoLoadModel.dispatchEvent(new Event('change', { bubbles: true }));
    cancelAfter.value = '3';
    cancelAfter.dispatchEvent(new Event('input', { bubbles: true }));
    forceStopAfter.value = '8';
    forceStopAfter.dispatchEvent(new Event('input', { bubbles: true }));
    expect(modelChoiceLabel?.textContent).toBe('始终使用对话原有模型');
    expect(harness.query('#settings-unsaved-indicator').textContent).toBe('*5 项未保存');

    harness.click('#complete-connection-advanced');
    await harness.flush();
    expect(harness.method('setConversationResumePreferences')).toHaveBeenCalledExactlyOnceWith({
      autoLoadLastConversationModelOnStartup: false,
      autoLoadLastConversationOnStartup: true,
      modelMismatchBehavior: 'use-conversation',
      startupModelConnectCancelAfterMinutes: 3,
      startupModelConnectForceStopAfterMinutes: 8,
    });
  });

  it('keeps settings open and reports an invalid timeout pair instead of pretending to save', async () => {
    harness = await createRendererHarness();
    harness.click('#open-connection-advanced');
    await harness.flush();

    const cancelAfter = harness.query<HTMLInputElement>(
      '#settings-startup-model-connect-cancel-after',
    );
    const forceStopAfter = harness.query<HTMLInputElement>(
      '#settings-startup-model-connect-force-stop-after',
    );
    cancelAfter.value = '5';
    cancelAfter.dispatchEvent(new Event('input', { bubbles: true }));
    forceStopAfter.value = '5';
    forceStopAfter.dispatchEvent(new Event('input', { bubbles: true }));

    harness.click('#complete-connection-advanced');
    await harness.flush();

    expect(harness.method('setConversationResumePreferences')).not.toHaveBeenCalled();
    expect(forceStopAfter.validationMessage).toContain('必须晚于');
    expect(harness.query('#toast').textContent).toContain('等待时间无效');
    expect(harness.query<HTMLDialogElement>('#connection-advanced-dialog').open).toBe(true);
  });
});
