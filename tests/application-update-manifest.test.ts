import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertReleaseVersionFloor,
  CHINA_MIRROR_BASE_URL,
  compareApplicationVersions,
  GITHUB_RELEASE_ROOT,
  readHighestTrustedVersion,
  recordHighestTrustedVersion,
  RELEASE_MANIFEST_KEY_ID,
  RELEASE_MANIFEST_LIMIT_BYTES,
  verifyDownloadedReleaseFile,
  verifyReleaseManifest,
} from '../src/main/application-update-manifest';

const directories: string[] = [];
const keyPair = generateKeyPairSync('ed25519');
const publicKeyPem = keyPair.publicKey.export({ format: 'pem', type: 'spki' }).toString();
const sha512 = (value: Uint8Array): string => createHash('sha512').update(value).digest('base64');

const createDirectory = (): string => {
  const directory = mkdtempSync(path.join(tmpdir(), 'claudedock-update-manifest-'));
  directories.push(directory);
  return directory;
};

const signedManifest = () => {
  const installer = new Uint8Array(256 * 1024).fill(7);
  const blockmap = new Uint8Array([1, 2, 3]);
  const latest = new TextEncoder().encode(
    'version: 4.1.0\npath: ClaudeDock-Setup-4.1.0-x64.exe\nsha512: ' + sha512(installer) + '\n',
  );
  const bytes = new TextEncoder().encode(
    JSON.stringify(
      {
        channel: 'stable',
        files: [
          {
            name: 'ClaudeDock-Setup-4.1.0-x64.exe',
            sampleSha512: sha512(installer),
            sampleSize: installer.byteLength,
            sha512: sha512(installer),
            size: installer.byteLength,
          },
          {
            name: 'ClaudeDock-Setup-4.1.0-x64.exe.blockmap',
            sha512: sha512(blockmap),
            size: blockmap.byteLength,
          },
          {
            name: 'latest.yml',
            sha512: sha512(latest),
            size: latest.byteLength,
          },
        ],
        keyId: RELEASE_MANIFEST_KEY_ID,
        publishedAt: '2026-08-03T12:00:00.000Z',
        schemaVersion: 1,
        sources: {
          github: GITHUB_RELEASE_ROOT + 'v4.1.0/',
          mirror: CHINA_MIRROR_BASE_URL,
        },
        version: '4.1.0',
      },
      null,
      2,
    ) + '\n',
  );
  const signature = sign(null, bytes, keyPair.privateKey).toString('base64') + '\n';
  return { bytes, installer, signature };
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('signed release manifests', () => {
  it('verifies an Ed25519 manifest and applies SemVer ordering', () => {
    const fixture = signedManifest();

    expect(verifyReleaseManifest(fixture.bytes, fixture.signature, publicKeyPem)).toMatchObject({
      keyId: RELEASE_MANIFEST_KEY_ID,
      version: '4.1.0',
    });
    expect(compareApplicationVersions('4.1.0', '4.1.0-rc.1')).toBeGreaterThan(0);
    expect(() => compareApplicationVersions('04.1.0', '4.1.0')).toThrow('SemVer');
    expect(() => compareApplicationVersions('4.1.0-01', '4.1.0')).toThrow('SemVer');
    expect(() => assertReleaseVersionFloor('4.1.0', '4.0.0', '4.0.1')).not.toThrow();
    expect(() => assertReleaseVersionFloor('4.1.0', '4.0.0', '4.2.0')).toThrow('已验证版本 4.2.0');
  });

  it('rejects manifest tampering and oversized metadata before parsing', () => {
    const fixture = signedManifest();
    const tampered = fixture.bytes.slice();
    tampered[10] = tampered[10] === 32 ? 33 : 32;

    expect(() => verifyReleaseManifest(tampered, fixture.signature, publicKeyPem)).toThrow(
      '签名验证失败',
    );
    expect(() =>
      verifyReleaseManifest(
        new Uint8Array(RELEASE_MANIFEST_LIMIT_BYTES + 1),
        fixture.signature,
        publicKeyPem,
      ),
    ).toThrow('64 KiB');
  });

  it('persists the highest trusted version without allowing the floor to decrease', () => {
    const floorPath = path.join(createDirectory(), 'version-floor.json');

    recordHighestTrustedVersion(floorPath, '4.2.0');
    recordHighestTrustedVersion(floorPath, '4.1.0');

    expect(readHighestTrustedVersion(floorPath)).toBe('4.2.0');
  });

  it('detects a full installer hash mismatch after download', async () => {
    const fixture = signedManifest();
    const installerPath = path.join(createDirectory(), 'ClaudeDock-Setup-4.1.0-x64.exe');
    writeFileSync(installerPath, fixture.installer);
    const expected = {
      name: path.basename(installerPath),
      sha512: sha512(fixture.installer),
      size: fixture.installer.byteLength,
    };

    await expect(verifyDownloadedReleaseFile(installerPath, expected)).resolves.toBeUndefined();
    writeFileSync(installerPath, new Uint8Array(fixture.installer.byteLength).fill(9));
    await expect(verifyDownloadedReleaseFile(installerPath, expected)).rejects.toThrow('SHA-512');
  });
});
