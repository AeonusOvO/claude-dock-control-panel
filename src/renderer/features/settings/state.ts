import type { AppSettingsView } from '../../../shared/contracts';

export type SettingsTab =
  'advanced' | 'claude-execution' | 'connection' | 'general' | 'network' | 'proxy' | 'router';

export interface SettingsState {
  saved?: AppSettingsView;
  selectedTab: SettingsTab;
}

export const createSettingsState = (): SettingsState => ({
  selectedTab: 'general',
});
