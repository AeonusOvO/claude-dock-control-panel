import type { MarkdownDomRenderer } from '../../platform/markdown';

export interface ChatActionsDependencies {
  chatComposer: HTMLFormElement;
  chatMessagesElement: HTMLElement;
  chatShell: HTMLElement;
  formatAttachmentSize: (sizeBytes: number) => string;
  formatTokenCount: (value: number | undefined) => string;
  getMarkdownRenderer: () => MarkdownDomRenderer;
  isArtifactDetailsOpen: () => boolean;
  isChatView: () => boolean;
  playSendAnimation: (
    text: string,
    source: HTMLTextAreaElement,
    variant: 'terminal' | 'chat',
  ) => void;
  resultFailureMessage: (result: unknown, fallback: string) => string;
  runGuarded: <T>(
    button: HTMLButtonElement,
    busyLabel: string,
    operation: () => Promise<T>,
  ) => Promise<T | undefined>;
  showToast: (message: string, tone?: 'error' | 'success') => void;
  stopArtifacts: () => void;
}
