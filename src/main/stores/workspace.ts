import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { WorkspaceProject } from '../../shared/contracts';
import { isTerminalThemeId, type TerminalThemeId } from '../../shared/ui/terminal-themes';

interface StoredWorkspace {
  lastActiveProject?: string;
  projects: WorkspaceProject[];
  /** Remembered so the very first frame is painted in the right colours instead of flashing. */
  terminalTheme?: TerminalThemeId;
  version: 1;
}

const EMPTY_WORKSPACE: StoredWorkspace = {
  projects: [],
  version: 1,
};

const normalizeProjectPath = (projectPath: string): string =>
  path.resolve(projectPath).toLowerCase();

export class WorkspaceStore {
  private readonly storageDirectory: string;
  private readonly storagePath: string;

  public constructor(userDataPath: string) {
    this.storageDirectory = path.join(userDataPath, 'claude');
    this.storagePath = path.join(this.storageDirectory, 'workspace.json');
  }

  public getProjects(): WorkspaceProject[] {
    return this.load().projects;
  }

  public getLastActiveProject(): string | undefined {
    return this.load().lastActiveProject;
  }

  public getTheme(): TerminalThemeId | undefined {
    return this.load().terminalTheme;
  }

  public setTheme(themeId: TerminalThemeId): void {
    const store = this.load();
    store.terminalTheme = themeId;
    this.persist(store);
  }

  public addProject(projectPath: string): void {
    const store = this.load();
    const normalized = normalizeProjectPath(projectPath);
    const existing = store.projects.find(
      (project) => normalizeProjectPath(project.path) === normalized,
    );

    if (existing) {
      existing.lastActiveAt = Date.now();
    } else {
      store.projects.push({
        addedAt: Date.now(),
        lastActiveAt: Date.now(),
        path: projectPath,
      });
    }

    store.lastActiveProject = projectPath;
    this.persist(store);
  }

  public removeProject(projectPath: string): void {
    const store = this.load();
    const normalized = normalizeProjectPath(projectPath);
    store.projects = store.projects.filter(
      (project) => normalizeProjectPath(project.path) !== normalized,
    );

    if (store.lastActiveProject && normalizeProjectPath(store.lastActiveProject) === normalized) {
      store.lastActiveProject = store.projects[0]?.path;
    }

    this.persist(store);
  }

  public updateLastActive(projectPath: string): void {
    const store = this.load();
    const normalized = normalizeProjectPath(projectPath);
    const project = store.projects.find((item) => normalizeProjectPath(item.path) === normalized);

    if (project) {
      project.lastActiveAt = Date.now();
      store.lastActiveProject = projectPath;
      this.persist(store);
    }
  }

  private load(): StoredWorkspace {
    try {
      const parsed = JSON.parse(readFileSync(this.storagePath, 'utf8')) as {
        lastActiveProject?: unknown;
        projects?: unknown;
        terminalTheme?: unknown;
        version?: unknown;
      };

      if (parsed.version !== 1 || !Array.isArray(parsed.projects)) {
        return structuredClone(EMPTY_WORKSPACE);
      }

      const projects: WorkspaceProject[] = [];
      for (const item of parsed.projects) {
        if (
          item &&
          typeof item === 'object' &&
          'path' in item &&
          typeof item.path === 'string' &&
          'addedAt' in item &&
          typeof item.addedAt === 'number' &&
          Number.isFinite(item.addedAt) &&
          'lastActiveAt' in item &&
          typeof item.lastActiveAt === 'number' &&
          Number.isFinite(item.lastActiveAt)
        ) {
          projects.push({
            addedAt: item.addedAt,
            lastActiveAt: item.lastActiveAt,
            path: item.path,
          });
        }
      }

      return {
        lastActiveProject:
          typeof parsed.lastActiveProject === 'string' ? parsed.lastActiveProject : undefined,
        projects,
        terminalTheme: isTerminalThemeId(parsed.terminalTheme) ? parsed.terminalTheme : undefined,
        version: 1,
      };
    } catch {
      return structuredClone(EMPTY_WORKSPACE);
    }
  }

  private persist(store: StoredWorkspace): void {
    mkdirSync(this.storageDirectory, { recursive: true });
    const temporaryPath = `${this.storagePath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(temporaryPath, this.storagePath);
  }
}
