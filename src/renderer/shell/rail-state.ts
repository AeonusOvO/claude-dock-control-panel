export interface RailMutableState {
  compactRailResizeFrame: number | undefined;
  compactRailRestoreTab: string | undefined;
  mainView: 'chat' | 'terminal';
  previewRailTab: string | undefined;
  railPreviewCloseTimer: number | undefined;
  selectedRailTab: string | undefined;
}

export const createRailMutableState = (): RailMutableState => ({
  compactRailResizeFrame: undefined,
  compactRailRestoreTab: undefined,
  mainView: 'terminal',
  previewRailTab: undefined,
  railPreviewCloseTimer: undefined,
  selectedRailTab: 'projects',
});
