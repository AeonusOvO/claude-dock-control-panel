import type { ControlPanelApi } from '../shared/contracts';

declare global {
  interface Window {
    controlPanel: ControlPanelApi;
  }
}

export {};
