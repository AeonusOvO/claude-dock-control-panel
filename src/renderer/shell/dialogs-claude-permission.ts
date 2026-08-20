import { requiredElement } from '../platform/dom';
import type { ClaudePermissionDecision, ClaudePermissionRequestView } from '../../shared/contracts';

export interface ClaudePermissionDialogActions {
  dispose: () => void;
}

export const createClaudePermissionDialogActions = (): ClaudePermissionDialogActions => {
  const claudePermissionDialog = requiredElement<HTMLDialogElement>('#claude-permission-dialog');
  const claudePermissionTool = requiredElement<HTMLElement>('#claude-permission-tool');
  const claudePermissionDescription = requiredElement<HTMLElement>(
    '#claude-permission-description',
  );
  const claudePermissionSuggestions = requiredElement<HTMLFieldSetElement>(
    '#claude-permission-suggestions',
  );
  const claudePermissionDenyReason = requiredElement<HTMLInputElement>(
    '#claude-permission-deny-reason',
  );
  const claudePermissionFallback = requiredElement<HTMLButtonElement>(
    '#claude-permission-fallback',
  );
  const claudePermissionDeny = requiredElement<HTMLButtonElement>('#claude-permission-deny');
  const claudePermissionAllow = requiredElement<HTMLButtonElement>('#claude-permission-allow');
  const claudePermissionQueue: ClaudePermissionRequestView[] = [];
  let activeClaudePermissionRequest: ClaudePermissionRequestView | undefined;
  let claudePermissionResponsePending = false;
  let claudePermissionExpiryTimer: number | undefined;

  const renderClaudePermissionRequest = (): void => {
    const request = activeClaudePermissionRequest;
    if (!request || claudePermissionResponsePending) return;
    claudePermissionTool.textContent = request.toolName;
    claudePermissionDescription.textContent = request.description;
    claudePermissionDenyReason.value = '';
    claudePermissionSuggestions.replaceChildren();
    claudePermissionSuggestions.hidden = request.suggestions.length === 0;
    for (const suggestion of request.suggestions) {
      const label = document.createElement('label');
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'claude-permission-suggestion';
      radio.value = suggestion.id;
      label.append(radio, document.createTextNode(suggestion.label));
      claudePermissionSuggestions.append(label);
    }
    claudePermissionAllow.textContent = '本次允许';
    claudePermissionSuggestions.addEventListener(
      'change',
      () => {
        claudePermissionAllow.textContent = '允许并保存所选范围';
      },
      { once: true },
    );
    claudePermissionDialog.returnValue = '';
    if (!claudePermissionDialog.open) claudePermissionDialog.showModal();
    if (claudePermissionExpiryTimer !== undefined) window.clearTimeout(claudePermissionExpiryTimer);
    claudePermissionExpiryTimer = window.setTimeout(
      () => void respondToClaudePermission({ behavior: 'fallback' }),
      Math.max(0, request.expiresAt - Date.now()),
    );
  };

  const showNextClaudePermissionRequest = (): void => {
    if (activeClaudePermissionRequest || claudePermissionQueue.length === 0) return;
    activeClaudePermissionRequest = claudePermissionQueue.shift();
    renderClaudePermissionRequest();
  };

  async function respondToClaudePermission(decision: ClaudePermissionDecision): Promise<void> {
    const request = activeClaudePermissionRequest;
    if (!request || claudePermissionResponsePending) return;
    claudePermissionResponsePending = true;
    claudePermissionAllow.disabled = true;
    claudePermissionDeny.disabled = true;
    claudePermissionFallback.disabled = true;
    if (claudePermissionExpiryTimer !== undefined) {
      window.clearTimeout(claudePermissionExpiryTimer);
      claudePermissionExpiryTimer = undefined;
    }
    try {
      await window.controlPanel.respondClaudePermission(request.requestId, decision);
    } finally {
      activeClaudePermissionRequest = undefined;
      claudePermissionResponsePending = false;
      claudePermissionAllow.disabled = false;
      claudePermissionDeny.disabled = false;
      claudePermissionFallback.disabled = false;
      if (claudePermissionDialog.open) claudePermissionDialog.close();
      window.setTimeout(showNextClaudePermissionRequest, 0);
    }
  }

  const unsubscribeClaudePermissionRequest = window.controlPanel.onClaudePermissionRequest(
    (request) => {
      if (
        request.expiresAt <= Date.now() ||
        request.requestId === activeClaudePermissionRequest?.requestId ||
        claudePermissionQueue.some((queued) => queued.requestId === request.requestId)
      ) {
        return;
      }
      claudePermissionQueue.push(request);
      showNextClaudePermissionRequest();
    },
  );

  claudePermissionFallback.addEventListener('click', () => {
    void respondToClaudePermission({ behavior: 'fallback' });
  });
  claudePermissionDeny.addEventListener('click', () => {
    const message = claudePermissionDenyReason.value.trim();
    void respondToClaudePermission({
      behavior: 'deny',
      ...(message ? { message } : {}),
    });
  });
  claudePermissionAllow.addEventListener('click', () => {
    const selected = claudePermissionSuggestions.querySelector<HTMLInputElement>(
      'input[name="claude-permission-suggestion"]:checked',
    );
    void respondToClaudePermission({
      behavior: 'allow',
      ...(selected?.value ? { suggestionId: selected.value } : {}),
    });
  });
  claudePermissionDialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    void respondToClaudePermission({ behavior: 'fallback' });
  });

  return {
    dispose: () => {
      unsubscribeClaudePermissionRequest();
      if (claudePermissionExpiryTimer !== undefined) {
        window.clearTimeout(claudePermissionExpiryTimer);
      }
    },
  };
};
