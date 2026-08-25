export interface RailMutableState {
  compactRailResizeFrame: number | undefined;
  compactRailRestoreTab: string | undefined;
  extensionDirection: 'backward' | 'forward';
  extensionTab: 'mcp' | 'plugins';
  mainView: 'chat' | 'terminal';
  previewRailTab: string | undefined;
  railPreviewCloseTimer: number | undefined;
  selectedRailTab: string | undefined;
}

export const createRailMutableState = (): RailMutableState => ({
  compactRailResizeFrame: undefined,
  compactRailRestoreTab: undefined,
  extensionDirection: 'forward',
  extensionTab: 'plugins',
  mainView: 'terminal',
  previewRailTab: undefined,
  railPreviewCloseTimer: undefined,
  selectedRailTab: 'projects',
});
