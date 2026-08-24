import sevenZip from '7zip-bin';
import { blake2b } from '@noble/hashes/blake2.js';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

const BLOCKMAP_MAXIMUM_BYTES = 16 * 1024 * 1024;
const COPY_BUFFER_BYTES = 1024 * 1024;
const CHECKSUM_BYTES = 18;
const CHECKSUM_PATTERN = /^[0-9A-Za-z+/]{24}$/u;
const { path7za } = sevenZip;

const messageOf = (value) => (value instanceof Error ? value.message : String(value));
const compareText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const normalizeRelativePath = (value) => value.split(path.sep).join('/');

const digestBytes = (bytes) => createHash('sha256').update(bytes).digest('hex');

const digestFile = (filePath) => {
  const descriptor = openSync(filePath, 'r');
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  let bytes = 0;
  try {
    while (true) {
      const count = readSync(descriptor, buffer, 0, buffer.byteLength, null);
      if (count === 0) break;
      bytes += count;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    closeSync(descriptor);
  }
  return { bytes, sha256: hash.digest('hex') };
};

const filesEqual = (leftPath, rightPath) => {
  if (statSync(leftPath).size !== statSync(rightPath).size) return false;
  const leftDescriptor = openSync(leftPath, 'r');
  const rightDescriptor = openSync(rightPath, 'r');
  const leftBuffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  const rightBuffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  try {
    while (true) {
      const leftCount = readSync(leftDescriptor, leftBuffer, 0, leftBuffer.byteLength, null);
      const rightCount = readSync(rightDescriptor, rightBuffer, 0, rightBuffer.byteLength, null);
      if (leftCount !== rightCount) return false;
      if (leftCount === 0) return true;
      if (!leftBuffer.subarray(0, leftCount).equals(rightBuffer.subarray(0, rightCount))) {
        return false;
      }
    }
  } finally {
    closeSync(leftDescriptor);
    closeSync(rightDescriptor);
  }
};

const describeTree = (rootPath) => {
  const entries = [];
  const visit = (directory, parentPath = '') => {
    const children = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      compareText(left.name, right.name),
    );
    for (const child of children) {
      const relativePath = normalizeRelativePath(path.join(parentPath, child.name));
      const absolutePath = path.join(directory, child.name);
      if (child.isDirectory()) {
        entries.push({ kind: 'directory', path: relativePath });
        visit(absolutePath, relativePath);
      } else if (child.isFile()) {
        entries.push({
          absolutePath,
          kind: 'file',
          path: relativePath,
          ...digestFile(absolutePath),
        });
      } else {
        throw new Error(`unsupported entry in app.asar.unpacked: ${relativePath}`);
      }
    }
  };
  visit(rootPath);
  return entries;
};

const treeEvidence = (entries) => {
  const records = entries.map((entry) =>
    entry.kind === 'directory'
      ? ['directory', entry.path]
      : ['file', entry.path, entry.bytes, entry.sha256],
  );
  const files = entries.filter((entry) => entry.kind === 'file');
  return {
    bytes: files.reduce((total, entry) => total + entry.bytes, 0),
    fileCount: files.length,
    sha256: digestBytes(
      Buffer.from(`${records.map((record) => JSON.stringify(record)).join('\n')}\n`),
    ),
  };
};

const compareUnpackedTrees = ({ installerTreePath, winUnpackedTreePath }) => {
  const installerEntries = describeTree(installerTreePath);
  const winUnpackedEntries = describeTree(winUnpackedTreePath);
  const installerByKey = new Map(
    installerEntries.map((entry) => [`${entry.kind}:${entry.path}`, entry]),
  );
  const winUnpackedByKey = new Map(
    winUnpackedEntries.map((entry) => [`${entry.kind}:${entry.path}`, entry]),
  );
  const installerKeys = [...installerByKey.keys()].sort(compareText);
  const winUnpackedKeys = [...winUnpackedByKey.keys()].sort(compareText);
  if (
    installerKeys.length !== winUnpackedKeys.length ||
    installerKeys.some((key, index) => key !== winUnpackedKeys[index])
  ) {
    throw new Error('installer payload app.asar.unpacked tree differs from win-unpacked');
  }
  for (const key of installerKeys) {
    const installerEntry = installerByKey.get(key);
    const winUnpackedEntry = winUnpackedByKey.get(key);
    if (
      installerEntry.kind === 'file' &&
      (!filesEqual(installerEntry.absolutePath, winUnpackedEntry.absolutePath) ||
        installerEntry.sha256 !== winUnpackedEntry.sha256)
    ) {
      throw new Error(
        `installer payload app.asar.unpacked bytes differ from win-unpacked: ${installerEntry.path}`,
      );
    }
  }
  return treeEvidence(winUnpackedEntries);
};

const requireRegularFile = (filePath, description) => {
  if (!existsSync(filePath) || !lstatSync(filePath).isFile()) {
    throw new Error(`missing ${description}`);
  }
};

const requireDirectory = (directoryPath, description) => {
  if (!existsSync(directoryPath) || !lstatSync(directoryPath).isDirectory()) {
    throw new Error(`missing ${description}`);
  }
};

const extractArchive = ({ archivePath, destination }) => {
  mkdirSync(destination, { recursive: true });
  execFileSync(path7za, ['x', archivePath, '-bd', '-bb0', '-y', `-o${destination}`], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
};

export const extractInstallerPayload = ({ destination, installerPath }) => {
  extractArchive({ archivePath: installerPath, destination });
};

export const inspectInstallerPayload = ({
  extractInstaller = extractInstallerPayload,
  installerPath,
  releaseDirectory,
  temporaryRoot = tmpdir(),
}) => {
  const extractionDirectory = mkdtempSync(path.join(temporaryRoot, 'claudedock-nsis-payload-'));
  try {
    extractInstaller({ destination: extractionDirectory, installerPath });
    const installerResources = path.join(extractionDirectory, 'resources');
    const unpackedResources = path.join(releaseDirectory, 'win-unpacked', 'resources');
    const installerAsarPath = path.join(installerResources, 'app.asar');
    const unpackedAsarPath = path.join(unpackedResources, 'app.asar');
    requireRegularFile(installerAsarPath, 'installer payload resources/app.asar');
    requireRegularFile(unpackedAsarPath, 'win-unpacked/resources/app.asar');
    if (!filesEqual(installerAsarPath, unpackedAsarPath)) {
      throw new Error('installer payload resources/app.asar bytes differ from win-unpacked');
    }

    const installerTreePath = path.join(installerResources, 'app.asar.unpacked');
    const unpackedTreePath = path.join(unpackedResources, 'app.asar.unpacked');
    requireDirectory(installerTreePath, 'installer payload resources/app.asar.unpacked');
    requireDirectory(unpackedTreePath, 'win-unpacked/resources/app.asar.unpacked');
    const appAsarUnpacked = compareUnpackedTrees({
      installerTreePath,
      winUnpackedTreePath: unpackedTreePath,
    });

    const installerUpdaterPath = path.join(installerResources, 'app-update.yml');
    const unpackedUpdaterPath = path.join(unpackedResources, 'app-update.yml');
    const installerHasUpdater = existsSync(installerUpdaterPath);
    const unpackedHasUpdater = existsSync(unpackedUpdaterPath);
    if (installerHasUpdater !== unpackedHasUpdater) {
      throw new Error(
        'installer payload resources/app-update.yml presence differs from win-unpacked',
      );
    }
    let appUpdate = null;
    if (installerHasUpdater) {
      requireRegularFile(installerUpdaterPath, 'installer payload resources/app-update.yml');
      requireRegularFile(unpackedUpdaterPath, 'win-unpacked/resources/app-update.yml');
      if (!filesEqual(installerUpdaterPath, unpackedUpdaterPath)) {
        throw new Error(
          'installer payload resources/app-update.yml bytes differ from win-unpacked',
        );
      }
      appUpdate = digestFile(unpackedUpdaterPath);
    }

    return {
      appAsar: digestFile(unpackedAsarPath),
      appAsarUnpacked,
      appUpdate,
      schemaVersion: 1,
    };
  } finally {
    rmSync(extractionDirectory, { force: true, recursive: true });
  }
};

const objectRecord = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;

const exactKeys = (value, expectedKeys, description) => {
  const actualKeys = Object.keys(value).sort(compareText);
  const sortedExpectedKeys = [...expectedKeys].sort(compareText);
  if (
    actualKeys.length !== sortedExpectedKeys.length ||
    actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
  ) {
    throw new Error(`${description} has unexpected fields`);
  }
};

const canonicalChecksum = (value) => {
  if (typeof value !== 'string' || !CHECKSUM_PATTERN.test(value)) return false;
  const bytes = Buffer.from(value, 'base64');
  return bytes.byteLength === CHECKSUM_BYTES && bytes.toString('base64') === value;
};

const verifyBlockmapChunks = ({ checksums, installerPath, sizes }) => {
  const descriptor = openSync(installerPath, 'r');
  let offset = 0;
  try {
    for (let index = 0; index < sizes.length; index += 1) {
      const size = sizes[index];
      const chunk = Buffer.allocUnsafe(size);
      let filled = 0;
      while (filled < size) {
        const count = readSync(descriptor, chunk, filled, size - filled, offset + filled);
        if (count === 0) {
          throw new Error(`blockmap chunk ${index} extends beyond the installer`);
        }
        filled += count;
      }
      const actual = Buffer.from(blake2b(chunk, { dkLen: CHECKSUM_BYTES })).toString('base64');
      if (actual !== checksums[index]) {
        throw new Error(`blockmap chunk ${index} checksum does not match the installer`);
      }
      offset += size;
    }
  } finally {
    closeSync(descriptor);
  }
};

export const inspectBlockmap = ({ blockmapPath, installerPath }) => {
  let document;
  try {
    document = JSON.parse(
      gunzipSync(readFileSync(blockmapPath), { maxOutputLength: BLOCKMAP_MAXIMUM_BYTES }).toString(
        'utf8',
      ),
    );
  } catch (error) {
    throw new Error(`blockmap is not valid gzip JSON: ${messageOf(error)}`, { cause: error });
  }
  const root = objectRecord(document);
  if (!root) throw new Error('blockmap root must be an object');
  exactKeys(root, ['files', 'version'], 'blockmap root');
  if (root.version !== '2') throw new Error('blockmap version must equal 2');
  if (!Array.isArray(root.files) || root.files.length !== 1) {
    throw new Error('blockmap must contain exactly one file');
  }
  const file = objectRecord(root.files[0]);
  if (!file) throw new Error('blockmap file entry must be an object');
  exactKeys(file, ['checksums', 'name', 'offset', 'sizes'], 'blockmap file entry');
  if (file.name !== 'file') throw new Error('blockmap file entry must be named file');
  if (file.offset !== 0) throw new Error('blockmap file offset must equal 0');
  if (!Array.isArray(file.sizes) || file.sizes.length === 0) {
    throw new Error('blockmap sizes must be a non-empty array');
  }
  if (!Array.isArray(file.checksums) || file.checksums.length !== file.sizes.length) {
    throw new Error('blockmap checksums must align exactly with sizes');
  }

  let coverageBytes = 0;
  for (let index = 0; index < file.sizes.length; index += 1) {
    const size = file.sizes[index];
    if (!Number.isSafeInteger(size) || size <= 0) {
      throw new Error(`blockmap chunk ${index} size must be a positive safe integer`);
    }
    coverageBytes += size;
    if (!Number.isSafeInteger(coverageBytes)) {
      throw new Error('blockmap coverage exceeds the safe integer range');
    }
    if (!canonicalChecksum(file.checksums[index])) {
      throw new Error(`blockmap chunk ${index} checksum must be canonical 18-byte Base64`);
    }
  }

  const installerBytes = statSync(installerPath).size;
  if (coverageBytes !== installerBytes) {
    throw new Error(
      `blockmap coverage ${coverageBytes} bytes does not equal installer size ${installerBytes}`,
    );
  }
  verifyBlockmapChunks({
    checksums: file.checksums,
    installerPath,
    sizes: file.sizes,
  });

  const structure = {
    files: [
      {
        checksums: file.checksums,
        name: file.name,
        offset: file.offset,
        sizes: file.sizes,
      },
    ],
    version: root.version,
  };
  return {
    algorithm: 'BLAKE2b-144',
    checksumBytes: CHECKSUM_BYTES,
    chunkCount: file.sizes.length,
    coverageBytes,
    fileName: file.name,
    offset: file.offset,
    structureSha256: digestBytes(Buffer.from(JSON.stringify(structure))),
    version: root.version,
  };
};
