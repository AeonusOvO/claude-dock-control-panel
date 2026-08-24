import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface SourceIdentity {
  gitHead: string;
  packageLockSha256: string;
  treeClean: boolean;
}

interface ReleaseStep {
  arguments: string[];
  name: string;
}

interface ReleaseTools {
  orchestrateRelease(options: {
    executeStep: (step: ReleaseStep & { projectRoot: string }) => void;
    isTrackedFile?: (options: { filePath: string; projectRoot: string }) => boolean;
    projectRoot: string;
    readGeneratedIdentity?: () => SourceIdentity;
    readIdentity: () => SourceIdentity;
    releaseDirectory?: string;
    steps?: readonly ReleaseStep[];
    writeOrchestration?: (options: {
      releaseDirectory: string;
      source: SourceIdentity;
      steps: readonly ReleaseStep[];
    }) => void;
  }): SourceIdentity;
  releaseSteps: readonly ReleaseStep[];
}

const projectRoot = path.join(__dirname, '..', '..');
const releaseTools = (await import(
  pathToFileURL(path.join(projectRoot, 'scripts', 'release', 'release.mjs')).href
)) as ReleaseTools;
const fixtureRoots: string[] = [];
const cleanIdentity: SourceIdentity = {
  gitHead: 'a'.repeat(40),
  packageLockSha256: 'b'.repeat(64),
  treeClean: true,
};

const createFixture = () => {
  const root = mkdtempSync(path.join(tmpdir(), 'claudedock-release-orchestrator-'));
  fixtureRoots.push(root);
  return { output: path.join(root, 'outputs'), root };
};

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('release orchestration', () => {
  it('runs fresh install, exact quality gates, dist, identity verification, and manifest in order', () => {
    const fixture = createFixture();
    const events: string[] = [];
    const executed: string[] = [];
    const readGeneratedIdentity = vi.fn(() => {
      events.push('packaged identity');
      return cleanIdentity;
    });
    const readIdentity = vi.fn(() => {
      events.push('source identity');
      return cleanIdentity;
    });
    const writeOrchestration = vi.fn(() => {
      events.push('release orchestration');
    });

    const result = releaseTools.orchestrateRelease({
      executeStep: ({ name }) => {
        events.push(`step: ${name}`);
        executed.push(name);
      },
      projectRoot: fixture.root,
      readGeneratedIdentity,
      readIdentity,
      writeOrchestration,
    });

    expect(executed).toEqual([
      'npm ci',
      'lint',
      'format',
      'all typechecks',
      'full Vitest',
      'dependency-cruiser',
      'dist',
      'release manifest',
    ]);
    expect(releaseTools.releaseSteps.map(({ arguments: arguments_ }) => arguments_)).toEqual([
      ['ci'],
      ['run', 'lint'],
      ['run', 'format:check'],
      ['run', 'typecheck'],
      ['test'],
      ['run', 'lint:deps'],
      ['run', 'dist'],
      ['run', 'release:manifest'],
    ]);
    expect(events).toEqual([
      'source identity',
      'step: npm ci',
      'source identity',
      'step: lint',
      'source identity',
      'step: format',
      'source identity',
      'step: all typechecks',
      'source identity',
      'step: full Vitest',
      'source identity',
      'step: dependency-cruiser',
      'source identity',
      'step: dist',
      'source identity',
      'packaged identity',
      'step: release manifest',
      'source identity',
      'release orchestration',
    ]);
    expect(readIdentity).toHaveBeenCalledTimes(releaseTools.releaseSteps.length + 1);
    expect(readGeneratedIdentity).toHaveBeenCalledTimes(1);
    expect(writeOrchestration).toHaveBeenCalledWith({
      releaseDirectory: path.join(fixture.root, 'outputs'),
      source: cleanIdentity,
      steps: releaseTools.releaseSteps,
    });
    expect(result).toEqual(cleanIdentity);
  });

  it('refuses dirty source before invoking npm', () => {
    const fixture = createFixture();
    const executeStep = vi.fn();

    expect(() =>
      releaseTools.orchestrateRelease({
        executeStep,
        projectRoot: fixture.root,
        readIdentity: () => ({ ...cleanIdentity, treeClean: false }),
      }),
    ).toThrow('release requires a clean exact HEAD');
    expect(executeStep).not.toHaveBeenCalled();
  });

  it('refuses a nonempty outputs directory before invoking npm', () => {
    const fixture = createFixture();
    mkdirSync(fixture.output, { recursive: true });
    writeFileSync(path.join(fixture.output, 'stale-installer.exe'), 'stale');
    const executeStep = vi.fn();

    expect(() =>
      releaseTools.orchestrateRelease({
        executeStep,
        projectRoot: fixture.root,
        readIdentity: () => cleanIdentity,
        releaseDirectory: fixture.output,
      }),
    ).toThrow('release requires an empty outputs directory');
    expect(executeStep).not.toHaveBeenCalled();
  });

  it('refuses a non-directory outputs path before invoking npm', () => {
    const fixture = createFixture();
    writeFileSync(fixture.output, 'not a directory');
    const executeStep = vi.fn();

    expect(() =>
      releaseTools.orchestrateRelease({
        executeStep,
        projectRoot: fixture.root,
        readIdentity: () => cleanIdentity,
        releaseDirectory: fixture.output,
      }),
    ).toThrow('release outputs path must be a directory');
    expect(executeStep).not.toHaveBeenCalled();
  });

  it('allows only the tracked outputs sentinel in an otherwise empty directory', () => {
    const fixture = createFixture();
    const sentinelPath = path.join(fixture.output, '.gitkeep');
    const isTrackedFile = vi.fn(() => true);
    mkdirSync(fixture.output, { recursive: true });
    writeFileSync(sentinelPath, '');

    expect(
      releaseTools.orchestrateRelease({
        executeStep: () => undefined,
        isTrackedFile,
        projectRoot: fixture.root,
        readGeneratedIdentity: () => cleanIdentity,
        readIdentity: () => cleanIdentity,
        releaseDirectory: fixture.output,
        writeOrchestration: () => undefined,
      }),
    ).toEqual(cleanIdentity);
    expect(isTrackedFile).toHaveBeenCalledWith({
      filePath: sentinelPath,
      projectRoot: fixture.root,
    });
  });

  it('rejects an untracked or non-file outputs sentinel before invoking npm', () => {
    const fixture = createFixture();
    const sentinelPath = path.join(fixture.output, '.gitkeep');
    mkdirSync(fixture.output, { recursive: true });
    writeFileSync(sentinelPath, '');
    const executeStep = vi.fn();

    expect(() =>
      releaseTools.orchestrateRelease({
        executeStep,
        isTrackedFile: () => false,
        projectRoot: fixture.root,
        readIdentity: () => cleanIdentity,
        releaseDirectory: fixture.output,
      }),
    ).toThrow('release outputs sentinel must be a tracked regular file');
    rmSync(sentinelPath);
    mkdirSync(sentinelPath);
    expect(() =>
      releaseTools.orchestrateRelease({
        executeStep,
        isTrackedFile: () => true,
        projectRoot: fixture.root,
        readIdentity: () => cleanIdentity,
        releaseDirectory: fixture.output,
      }),
    ).toThrow('release outputs sentinel must be a tracked regular file');
    expect(executeStep).not.toHaveBeenCalled();
  });

  it('rejects source drift and stale generated identity immediately after dist', () => {
    const fixture = createFixture();
    let distRan = false;
    expect(() =>
      releaseTools.orchestrateRelease({
        executeStep: () => {
          distRan = true;
        },
        projectRoot: fixture.root,
        readIdentity: () =>
          distRan ? { ...cleanIdentity, packageLockSha256: 'c'.repeat(64) } : cleanIdentity,
        steps: [{ arguments: ['run', 'dist'], name: 'dist' }],
      }),
    ).toThrow('after dist: package-lock.json SHA-256 changed during release');

    expect(() =>
      releaseTools.orchestrateRelease({
        executeStep: () => undefined,
        projectRoot: fixture.root,
        readGeneratedIdentity: () => ({ ...cleanIdentity, gitHead: 'd'.repeat(40) }),
        readIdentity: () => cleanIdentity,
        steps: [{ arguments: ['run', 'dist'], name: 'packaging boundary' }],
      }),
    ).toThrow('after packaging boundary packaged identity: Git HEAD changed during release');
  });

  it('keeps npm run dist as the packaging boundary behind the Node release entrypoint', () => {
    const packageManifest = JSON.parse(
      readFileSync(path.join(projectRoot, 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };
    expect(packageManifest.scripts?.release).toBe('node scripts/release/release.mjs');
    expect(packageManifest.scripts?.dist).toBe('npm run build && electron-builder --win nsis');
  });
});
