import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import {
  packagedSourceIdentityArchivePath,
  readSourceIdentity,
} from '../build/source-identity.mjs';

export const defaultProjectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

export const releaseSteps = Object.freeze([
  { arguments: ['ci'], name: 'npm ci' },
  { arguments: ['run', 'lint'], name: 'lint' },
  { arguments: ['run', 'format:check'], name: 'format' },
  { arguments: ['run', 'typecheck'], name: 'all typechecks' },
  { arguments: ['test'], name: 'full Vitest' },
  { arguments: ['run', 'lint:deps'], name: 'dependency-cruiser' },
  { arguments: ['run', 'dist'], name: 'dist' },
  { arguments: ['run', 'release:manifest'], name: 'release manifest' },
]);
export const releaseOrchestrationFileName = 'release-orchestration.json';

const fullObjectId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const sha256 = /^[0-9a-f]{64}$/u;

const messageOf = (value) => (value instanceof Error ? value.message : String(value));

const validSourceIdentity = (identity) =>
  fullObjectId.test(identity?.gitHead) &&
  sha256.test(identity?.packageLockSha256) &&
  typeof identity?.treeClean === 'boolean';

export const assertCleanExactSource = (identity, stage = 'release start') => {
  if (!validSourceIdentity(identity)) {
    throw new Error(`${stage}: source identity is incomplete or invalid`);
  }
  if (identity.treeClean !== true) {
    throw new Error(`${stage}: release requires a clean exact HEAD`);
  }
  return identity;
};

export const assertSourceIdentityUnchanged = (expected, actual, stage) => {
  assertCleanExactSource(expected, 'release baseline');
  assertCleanExactSource(actual, stage);
  const mismatches = [];
  if (actual.gitHead !== expected.gitHead) mismatches.push('Git HEAD');
  if (actual.packageLockSha256 !== expected.packageLockSha256) {
    mismatches.push('package-lock.json SHA-256');
  }
  if (mismatches.length > 0) {
    throw new Error(`${stage}: ${mismatches.join(' and ')} changed during release`);
  }
};

const gitTracksFile = ({ filePath, projectRoot }) => {
  const relativePath = path.relative(projectRoot, filePath);
  if (
    relativePath === '' ||
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    return false;
  }
  try {
    execFileSync(
      'git',
      [
        '-C',
        projectRoot,
        'ls-files',
        '--error-unmatch',
        '--',
        relativePath.split(path.sep).join('/'),
      ],
      { stdio: 'ignore' },
    );
    return true;
  } catch {
    return false;
  }
};

export const assertReleaseDirectoryEmpty = ({
  isTrackedFile = gitTracksFile,
  projectRoot = defaultProjectRoot,
  releaseDirectory = path.join(projectRoot, 'outputs'),
} = {}) => {
  if (!existsSync(releaseDirectory)) return;
  if (!lstatSync(releaseDirectory).isDirectory()) {
    throw new Error('release outputs path must be a directory');
  }
  const entries = readdirSync(releaseDirectory).sort();
  if (entries.length === 0) return;
  if (entries.length !== 1 || entries[0] !== '.gitkeep') {
    throw new Error(`release requires an empty outputs directory; found: ${entries.join(', ')}`);
  }
  const sentinelPath = path.join(releaseDirectory, '.gitkeep');
  if (
    !lstatSync(sentinelPath).isFile() ||
    !isTrackedFile({ filePath: sentinelPath, projectRoot })
  ) {
    throw new Error('release outputs sentinel must be a tracked regular file: .gitkeep');
  }
};

export const readGeneratedSourceIdentity = ({ projectRoot = defaultProjectRoot } = {}) => {
  const identityPath = path.join(projectRoot, ...packagedSourceIdentityArchivePath.split('/'));
  let document;
  try {
    document = JSON.parse(readFileSync(identityPath, 'utf8'));
  } catch (error) {
    throw new Error(`packaged source identity cannot be read: ${messageOf(error)}`, {
      cause: error,
    });
  }
  const expectedKeys = ['gitHead', 'packageLockSha256', 'schemaVersion', 'treeClean'];
  const actualKeys =
    document && typeof document === 'object' && !Array.isArray(document)
      ? Object.keys(document).sort()
      : [];
  if (
    document?.schemaVersion !== 1 ||
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index]) ||
    !validSourceIdentity(document)
  ) {
    throw new Error('packaged source identity has an invalid or non-canonical document');
  }
  return {
    gitHead: document.gitHead,
    packageLockSha256: document.packageLockSha256,
    treeClean: document.treeClean,
  };
};

const orchestrationSteps = (steps) =>
  steps.map((step) => ({ arguments: [...step.arguments], name: step.name }));

const exactKeys = (value, expectedKeys, description) => {
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  if (
    actualKeys.length !== sortedExpectedKeys.length ||
    actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
  ) {
    throw new Error(`${description} has unexpected fields`);
  }
};

const sha256Bytes = (bytes) => createHash('sha256').update(bytes).digest('hex');

export const writeReleaseOrchestration = ({
  releaseDirectory = path.join(defaultProjectRoot, 'outputs'),
  source,
  steps = releaseSteps,
}) => {
  assertCleanExactSource(source, 'release orchestration');
  const reportPath = path.join(releaseDirectory, 'release-manifest.json');
  let reportBytes;
  let report;
  try {
    reportBytes = readFileSync(reportPath);
    report = JSON.parse(reportBytes.toString('utf8'));
  } catch (error) {
    throw new Error(`release manifest cannot be frozen by the orchestrator: ${messageOf(error)}`, {
      cause: error,
    });
  }
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    throw new Error(
      'release manifest cannot be frozen by the orchestrator: root must be an object',
    );
  }
  if (!Array.isArray(report.problems) || report.problems.length > 0) {
    throw new Error(
      'release manifest cannot be frozen by the orchestrator: validation has problems',
    );
  }
  assertSourceIdentityUnchanged(source, report.source, 'release manifest');

  const record = {
    releaseManifest: {
      bytes: reportBytes.byteLength,
      sha256: sha256Bytes(reportBytes),
    },
    schemaVersion: 1,
    source,
    steps: orchestrationSteps(steps),
  };
  const recordPath = path.join(releaseDirectory, releaseOrchestrationFileName);
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return { record, recordPath };
};

export const loadReleaseOrchestration = ({
  releaseDirectory = path.join(defaultProjectRoot, 'outputs'),
  reportBytes,
  source,
}) => {
  const recordPath = path.join(releaseDirectory, releaseOrchestrationFileName);
  let record;
  try {
    record = JSON.parse(readFileSync(recordPath, 'utf8'));
  } catch (error) {
    throw new Error(`release orchestration record cannot be read: ${messageOf(error)}`, {
      cause: error,
    });
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('release orchestration record root must be an object');
  }
  exactKeys(
    record,
    ['releaseManifest', 'schemaVersion', 'source', 'steps'],
    'release orchestration record',
  );
  if (record.schemaVersion !== 1) {
    throw new Error('release orchestration record schemaVersion must equal 1');
  }
  if (!record.releaseManifest || typeof record.releaseManifest !== 'object') {
    throw new Error('release orchestration record manifest evidence must be an object');
  }
  exactKeys(record.releaseManifest, ['bytes', 'sha256'], 'release orchestration manifest evidence');
  if (
    !Number.isSafeInteger(record.releaseManifest.bytes) ||
    record.releaseManifest.bytes <= 0 ||
    !sha256.test(record.releaseManifest.sha256)
  ) {
    throw new Error('release orchestration record manifest evidence is invalid');
  }
  assertCleanExactSource(record.source, 'release orchestration record');
  if (!isDeepStrictEqual(record.source, source)) {
    throw new Error('release orchestration record source differs from the frozen manifest');
  }
  if (!isDeepStrictEqual(record.steps, orchestrationSteps(releaseSteps))) {
    throw new Error('release orchestration record does not contain the exact release steps');
  }
  if (
    record.releaseManifest.bytes !== reportBytes.byteLength ||
    record.releaseManifest.sha256 !== sha256Bytes(reportBytes)
  ) {
    throw new Error('frozen release manifest differs from the orchestrated manifest');
  }
  return record;
};

export const executeReleaseStep = ({ arguments: arguments_, projectRoot = defaultProjectRoot }) =>
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', arguments_, {
    cwd: projectRoot,
    stdio: 'inherit',
  });

const isDistributionStep = (step) =>
  step.arguments.length === 2 && step.arguments[0] === 'run' && step.arguments[1] === 'dist';

export const orchestrateRelease = ({
  executeStep = executeReleaseStep,
  isTrackedFile,
  projectRoot = defaultProjectRoot,
  readGeneratedIdentity = readGeneratedSourceIdentity,
  readIdentity = readSourceIdentity,
  releaseDirectory = path.join(projectRoot, 'outputs'),
  steps = releaseSteps,
  writeOrchestration = writeReleaseOrchestration,
} = {}) => {
  const baseline = assertCleanExactSource(readIdentity({ projectRoot }));
  assertReleaseDirectoryEmpty({ isTrackedFile, projectRoot, releaseDirectory });

  for (const step of steps) {
    executeStep({ ...step, projectRoot });
    const current = readIdentity({ projectRoot });
    assertSourceIdentityUnchanged(baseline, current, `after ${step.name}`);
    if (isDistributionStep(step)) {
      assertSourceIdentityUnchanged(
        baseline,
        readGeneratedIdentity({ projectRoot }),
        `after ${step.name} packaged identity`,
      );
    }
  }

  writeOrchestration({ releaseDirectory, source: baseline, steps });
  return baseline;
};

export const runReleaseCli = () => {
  try {
    const source = orchestrateRelease();
    console.log(`release validated from exact source ${source.gitHead}`);
    return source;
  } catch (error) {
    console.error(`release failed: ${messageOf(error)}`);
    process.exitCode = 1;
    return undefined;
  }
};

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  runReleaseCli();
}
