import type { AppSettingsView } from '../../../shared/contracts';

export type SettingsTab = 'advanced' | 'connection' | 'general' | 'proxy' | 'router';

export interface SettingsState {
  saved?: AppSettingsView;
  selectedTab: SettingsTab;
}

export const createSettingsState = (): SettingsState => ({
  selectedTab: 'general',
});
