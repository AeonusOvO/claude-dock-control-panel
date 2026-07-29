import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DevelopmentRuntime } from '../shared/contracts';

interface StoredAgentRuntimes {
  projects: Record<string, DevelopmentRuntime>;
  version: 1;
}

const EMPTY_STORE: StoredAgentRuntimes = {
  projects: {},
  version: 1,
};

const projectKey = (projectPath: string): string => path.resolve(projectPath).toLowerCase();

const isDevelopmentRuntime = (value: unknown): value is DevelopmentRuntime =>
  value === 'claude' || value === 'codex';

export class AgentRuntimeStore {
  private readonly storageDirectory: string;
  private readonly storagePath: string;

  public constructor(userDataPath: string) {
    this.storageDirectory = path.join(userDataPath, 'claude');
    this.storagePath = path.join(this.storageDirectory, 'agent-runtimes.json');
  }

  public get(projectPath: string): DevelopmentRuntime {
    return this.load().projects[projectKey(projectPath)] ?? 'claude';
  }

  public set(projectPath: string, runtime: DevelopmentRuntime): void {
    const store = this.load();
    store.projects[projectKey(projectPath)] = runtime;
    this.persist(store);
  }

  public remove(projectPath: string): void {
    const store = this.load();
    delete store.projects[projectKey(projectPath)];
    this.persist(store);
  }

  private load(): StoredAgentRuntimes {
    try {
      const parsed = JSON.parse(readFileSync(this.storagePath, 'utf8')) as {
        projects?: unknown;
        version?: unknown;
      };
      if (parsed.version !== 1 || !parsed.projects || typeof parsed.projects !== 'object') {
        return structuredClone(EMPTY_STORE);
      }
      const projects: Record<string, DevelopmentRuntime> = {};
      for (const [key, value] of Object.entries(parsed.projects)) {
        if (path.isAbsolute(key) && isDevelopmentRuntime(value)) {
          projects[key.toLowerCase()] = value;
        }
      }
      return { projects, version: 1 };
    } catch {
      return structuredClone(EMPTY_STORE);
    }
  }

  private persist(store: StoredAgentRuntimes): void {
    mkdirSync(this.storageDirectory, { recursive: true });
    const temporaryPath = `${this.storagePath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(temporaryPath, this.storagePath);
  }
}
