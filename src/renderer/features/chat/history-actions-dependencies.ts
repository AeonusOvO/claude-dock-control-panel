export interface ChatHistoryActionsDependencies {
  formatTokenCount: (value: number | undefined) => string;
  requestConfirmation: (options: {
    confirmLabel?: string;
    message: string;
    title: string;
    tone?: 'default' | 'danger';
  }) => Promise<boolean>;
  requestConversationTitle: (currentTitle: string, historical: boolean) => Promise<string | null>;
  showToast: (message: string, tone?: 'error' | 'success') => void;
}
