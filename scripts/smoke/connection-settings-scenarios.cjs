/* global document */
/** Real renderer interactions; never submits a key or changes a saved profile. */
module.exports = async ({ capture, click, evaluate, waitFor }) => {
  const inspect = (formId) => {
    const form = document.querySelector(formId);
    const fields = [...form.querySelectorAll('[data-connection-advanced]')];
    return {
      mode: form.dataset.settingsMode,
      advancedVisible: fields.some((field) => field.getClientRects().length > 0),
      overflow: form.scrollWidth > form.clientWidth + 2,
    };
  };
  const assertForm = async (formId, mode) => {
    const state = await evaluate('(' + inspect.toString() + ')(' + JSON.stringify(formId) + ')');
    if (state.mode !== mode || state.advancedVisible !== (mode === 'advanced') || state.overflow) {
      throw new Error('Connection form mismatch: ' + JSON.stringify({ formId, mode, state }));
    }
  };

  await click('[data-rail-tab="connection"]');
  await waitFor(
    '() => Boolean(document.querySelector("[data-access-choice=domestic]"))',
    'the provider picker',
  );
  await click('[data-access-choice="domestic"]');
  await click('#connection-wizard-next');
  await waitFor(
    '() => !document.querySelector("#connection-settings-mode").disabled',
    'the prepared connection form',
  );
  await assertForm('#claude-config-form', 'simple');
  if (!(await evaluate('document.querySelector("#base-url-field").hidden')))
    throw new Error('Domestic URL should be hidden.');
  await capture(
    'connection-simple-domestic.png',
    {
      interaction: 'connection-simple',
      provider: 'deepseek',
    },
    450,
  );
  await click('#connection-settings-mode');
  await assertForm('#claude-config-form', 'advanced');
  await capture('connection-advanced.png', { interaction: 'connection-advanced' }, 450);
  await click('#connection-settings-mode');
  await assertForm('#claude-config-form', 'simple');

  await click('#connection-wizard-previous');
  await click('#connection-domestic-model');
  await capture(
    'connection-subscription-picker.png',
    { interaction: 'subscription-api-pills' },
    450,
  );
  await click('.select__listbox[data-open="true"] [data-value="kimi-subscription"]');
  await click('#connection-wizard-next');
  await waitFor(
    '() => Boolean(document.querySelector(".domestic-subscription-guide"))',
    'subscription login',
  );
  const subscription = await evaluate(`(() => {
    const guide = document.querySelector('.domestic-subscription-guide');
    return {
      formHidden: document.querySelector('#claude-config-form').hidden,
      notice: guide.querySelector('.field-help').textContent.trim(),
      login: document.querySelector('#connection-wizard-next').textContent,
      overflow: guide.scrollWidth > guide.clientWidth + 2,
    };
  })()`);
  if (
    !subscription.formHidden ||
    subscription.notice !== '可能会消耗少量 token' ||
    subscription.login !== '登录并连接' ||
    subscription.overflow
  ) {
    throw new Error('Subscription form mismatch: ' + JSON.stringify(subscription));
  }
  await capture(
    'connection-subscription-login.png',
    { interaction: 'subscription-login', provider: 'kimi' },
    450,
  );
  // No login click here: this isolated UI gate must not touch a real account or authorization page.

  await click('[data-rail-tab="chat"]');
  await click('#open-chat-settings');
  await waitFor(
    '() => document.querySelector("#chat-config-form").getAttribute("aria-busy") === "false"',
    'the chat settings load',
  );
  await click('#chat-provider');
  await capture('chat-provider-menu.png', { interaction: 'chat-provider-menu' }, 450);
  await click('#chat-settings-dialog .select__listbox[data-open="true"] [data-value="deepseek"]');
  await assertForm('#chat-config-form', 'simple');
  if (!(await evaluate('document.querySelector("#chat-base-url-field").hidden')))
    throw new Error('Domestic chat URL should be hidden.');
  if (
    await evaluate(
      '["#test-chat-connection", "#chat-connection-test", "#chat-config-status"].some((id) => document.querySelector(id).getClientRects().length > 0)',
    )
  )
    throw new Error('Simple chat settings should only show the primary connection action.');
  const cost = await evaluate(
    'document.querySelector("#chat-config-form .connection-cost-notice").textContent.trim()',
  );
  if (cost !== '可能会消耗少量 token') throw new Error('The default cost notice must stay short.');
  await capture(
    'chat-simple-domestic.png',
    { interaction: 'chat-simple', provider: 'deepseek' },
    450,
  );
  await click('#chat-settings-mode');
  await assertForm('#chat-config-form', 'advanced');
  await capture('chat-advanced.png', { interaction: 'chat-advanced' }, 450);
  await click('#chat-settings-mode');
  await assertForm('#chat-config-form', 'simple');
  await click('#close-chat-settings');
  await click('[data-rail-tab="projects"]');
};
