import { CHANNELS } from '../../shared/ipc/channels';
import { dialog, Menu, nativeImage, Tray } from 'electron';
import type { BrowserWindow, MenuItemConstructorOptions } from 'electron';
import path from 'node:path';
import type {
  DirectoryChoiceResult,
  TerminalStatus,
  WorkspaceResult,
  WorkspaceState,
} from '../../shared/contracts';
import { collectTrayMenuItems, type TrayMenuItemContribution } from '../infra/contributions';
import type { Registry } from '../infra/registry';
import { BUSY_REGISTRY, MAIN_WINDOW, TRAY } from '../infra/service-tokens';
import type { TerminalTransitionCoordinator } from '../terminal/lifecycle';
import type { DescribeWorkspace, TerminalWorkspace } from '../terminal/workspace';
import { assetPath } from './paths';

export interface TrayControllerDependencies {
  activateProject: (sessionId: string) => WorkspaceState;
  addProject: (directoryPath: string) => WorkspaceResult;
  chooseDirectory: (ownerWindow?: BrowserWindow) => Promise<DirectoryChoiceResult>;
  describeWorkspace: DescribeWorkspace;
  directTerminalTransitions: TerminalTransitionCoordinator;
  requestQuit: () => void;
  services: Registry;
  showMainWindow: () => void;
  workspace: TerminalWorkspace;
}

/** Tray creation is separate from refresh because the icon only exists in profiles that enable it. */
export interface TrayController {
  createTray: () => void;
  updateTray: (state?: WorkspaceState) => void;
}

interface TrayMenuContext {
  activeStatus: TerminalStatus | undefined;
  directTerminalTransitions: TerminalTransitionCoordinator;
  downloadLeaseCount: number;
  openProjectCount: number;
  pickDirectoryFromTray: () => Promise<void>;
  projectMenu: MenuItemConstructorOptions[];
  requestQuit: () => void;
  runningCount: number;
  services: Registry;
  sessionCount: number;
  showMainWindow: () => void;
  workspace: TerminalWorkspace;
}

type TrayMenuContribution = TrayMenuItemContribution<TrayMenuContext, MenuItemConstructorOptions>;

const projectTrayMenuItems: TrayMenuContribution = ({
  openProjectCount,
  pickDirectoryFromTray,
  projectMenu,
  runningCount,
  sessionCount,
}) => [
  {
    enabled: false,
    label: `项目：${openProjectCount} 个 · 对话：${sessionCount} 个 · 运行中：${runningCount} 个`,
  },
  {
    enabled: projectMenu.length > 0,
    label: '切换对话',
    submenu: projectMenu,
  },
  {
    click: () => {
      void pickDirectoryFromTray();
    },
    label: '添加项目…',
  },
];

const trayMenuSeparator: TrayMenuContribution = () => [{ type: 'separator' }];

const windowTrayMenuItems: TrayMenuContribution = ({
  downloadLeaseCount,
  services,
  showMainWindow,
}) => [
  {
    click: showMainWindow,
    label: '显示控制面板',
  },
  ...(downloadLeaseCount > 0
    ? [
        {
          click: () => {
            showMainWindow();
            services
              .resolve(MAIN_WINDOW)
              .current?.webContents.send(CHANNELS.APP_OPEN_DOWNLOAD_CENTER);
          },
          label: `打开下载中心（${downloadLeaseCount}）`,
        } satisfies MenuItemConstructorOptions,
      ]
    : []),
];

const terminalTrayMenuItems: TrayMenuContribution = ({
  activeStatus,
  directTerminalTransitions,
  workspace,
}) => {
  if (!activeStatus) {
    return [];
  }

  return [
    {
      click: () => {
        void directTerminalTransitions
          .run(activeStatus.id, activeStatus.ptyGeneration, () =>
            workspace.restart(activeStatus.id),
          )
          .catch(() => {});
      },
      label: `重启 ${sessionLabel(activeStatus)}`,
    },
    {
      click: () => {
        void directTerminalTransitions
          .run(activeStatus.id, activeStatus.ptyGeneration, () =>
            activeStatus.phase === 'running'
              ? workspace.stop(activeStatus.id)
              : workspace.start(activeStatus.id),
          )
          .catch(() => {});
      },
      label: activeStatus.phase === 'running' ? '停止当前终端' : '启动当前终端',
    },
  ];
};

const quitTrayMenuItems: TrayMenuContribution = ({ requestQuit }) => [
  {
    click: requestQuit,
    label: '退出 ClaudeDock',
  },
];

const TRAY_MENU_CONTRIBUTIONS = [
  projectTrayMenuItems,
  trayMenuSeparator,
  windowTrayMenuItems,
  terminalTrayMenuItems,
  trayMenuSeparator,
  quitTrayMenuItems,
] as const satisfies readonly TrayMenuContribution[];

const statusText = (status: TerminalStatus): string => {
  switch (status.phase) {
    case 'starting':
      return '终端启动中';
    case 'running':
      return '终端运行中';
    case 'error':
      return '终端出错';
    case 'stopped':
      return '终端已停止';
  }
};

const projectName = (status: TerminalStatus): string => path.basename(status.cwd) || status.cwd;

const sessionLabel = (status: TerminalStatus): string => `${projectName(status)} · ${status.title}`;

const trayIconForState = (state: WorkspaceState): string => {
  if (state.sessions.some((session) => session.phase === 'error')) {
    return assetPath('tray-error.png');
  }
  if (state.sessions.some((session) => session.phase === 'running')) {
    return assetPath('tray-running.png');
  }
  return assetPath('tray-idle.png');
};

export const createTrayController = ({
  activateProject,
  addProject,
  chooseDirectory,
  describeWorkspace,
  directTerminalTransitions,
  requestQuit,
  services,
  showMainWindow,
  workspace,
}: TrayControllerDependencies): TrayController => {
  const pickDirectoryFromTray = async (): Promise<void> => {
    try {
      showMainWindow();
      const choice = await chooseDirectory(services.resolve(MAIN_WINDOW).current ?? undefined);
      if (!choice.canceled) {
        const added = addProject(choice.path);
        if (!added.ok) {
          throw new Error(added.error ?? '无法添加该项目。');
        }
      } else if (choice.error) {
        throw new Error(choice.error);
      }
    } catch (error) {
      await dialog.showMessageBox({
        message: error instanceof Error ? error.message : '无法打开该文件夹。',
        title: '添加项目失败',
        type: 'error',
      });
    }
  };

  function updateTray(state = describeWorkspace()): void {
    const tray = services.resolve(TRAY).current;
    if (!tray) {
      return;
    }

    const activeStatus =
      state.sessions.find((session) => session.id === state.activeSessionId) ?? state.sessions[0];
    const runningCount = state.sessions.filter((session) => session.phase === 'running').length;
    const openProjects = state.projects.filter((project) => project.open);
    const leases = services.resolve(BUSY_REGISTRY).list();
    const downloadLeases = leases.filter(({ kind }) => kind === 'download');
    const blockingLeases = leases.filter(({ severity }) => severity === 'blocking');
    // One submenu per folder so a project with several conversations reads as one project.
    const projectMenu: MenuItemConstructorOptions[] = openProjects.map((project) => ({
      label: project.name,
      submenu: project.sessionIds.map((sessionId) => {
        const status = state.sessions.find((session) => session.id === sessionId);
        return {
          checked: sessionId === state.activeSessionId,
          click: () => {
            activateProject(sessionId);
            showMainWindow();
          },
          label: status ? `${status.title} · ${statusText(status)}` : sessionId,
          type: 'radio' as const,
        };
      }),
    }));

    const icon = nativeImage.createFromPath(trayIconForState(state));
    tray.setImage(icon);
    const workSummary =
      leases.length === 0
        ? '后台空闲'
        : `${leases.length} 项后台任务${blockingLeases.length > 0 ? `，${blockingLeases.length} 项不可中断` : ''}`;
    tray.setToolTip(
      [
        `ClaudeDock · ${openProjects.length} 个项目 · ${runningCount}/${state.sessions.length} 个对话运行中`,
        workSummary,
        activeStatus?.cwd,
      ]
        .filter(Boolean)
        .join('\n'),
    );
    tray.setContextMenu(
      Menu.buildFromTemplate(
        collectTrayMenuItems(
          {
            activeStatus,
            directTerminalTransitions,
            downloadLeaseCount: downloadLeases.length,
            openProjectCount: openProjects.length,
            pickDirectoryFromTray,
            projectMenu,
            requestQuit,
            runningCount,
            services,
            sessionCount: state.sessions.length,
            showMainWindow,
            workspace,
          },
          TRAY_MENU_CONTRIBUTIONS,
        ),
      ),
    );
  }

  const createTray = (): void => {
    const trayReference = services.resolve(TRAY);
    const tray = new Tray(nativeImage.createFromPath(trayIconForState(describeWorkspace())));
    trayReference.current = tray;
    tray.on('click', showMainWindow);
    tray.on('double-click', showMainWindow);
    updateTray();
  };

  return { createTray, updateTray };
};
