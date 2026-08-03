import { Buffer } from 'node:buffer';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import process from 'node:process';

const version = process.argv[2];
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? '')) {
  throw new Error('Usage: node scripts/verify-release-channels.mjs <stable-version>');
}

const githubBase =
  'https://github.com/AeonusOvO/claude-dock-control-panel/releases/download/v' + version + '/';
const mirrorBase = 'https://124.221.158.247/claudedock/windows/x64/';
const installerName = 'ClaudeDock-Setup-' + version + '-x64.exe';
const channels = [
  {
    allowedHosts: [
      'github.com',
      'objects.githubusercontent.com',
      'release-assets.githubusercontent.com',
    ],
    baseUrl: githubBase,
    id: 'github',
    maxRedirects: 5,
  },
  {
    allowedHosts: ['124.221.158.247'],
    baseUrl: mirrorBase,
    id: 'mirror',
    maxRedirects: 0,
  },
];

const urlAllowed = (channel, value) => {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== '443') ||
    !channel.allowedHosts.includes(url.hostname)
  ) {
    return false;
  }
  if (channel.id === 'mirror') {
    return (
      !url.search &&
      url.hostname === '124.221.158.247' &&
      url.pathname.startsWith('/claudedock/windows/x64/')
    );
  }
  if (url.hostname === 'github.com') {
    return !url.search && url.pathname.startsWith('/AeonusOvO/claude-dock-control-panel/releases/');
  }
  return url.pathname.length > 1;
};

const request = async (channel, initialUrl, init = {}) => {
  let requestUrl = initialUrl;
  for (let redirectCount = 0; redirectCount <= channel.maxRedirects; redirectCount += 1) {
    if (!urlAllowed(channel, requestUrl)) {
      throw new Error(channel.id + ' requested an unauthorized URL.');
    }
    const response = await fetch(requestUrl, {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(30 * 60 * 1000),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      if (!urlAllowed(channel, response.url || requestUrl)) {
        throw new Error(channel.id + ' responded from an unauthorized URL.');
      }
      return response;
    }
    if (redirectCount === channel.maxRedirects) {
      throw new Error(channel.id + ' exceeded its redirect limit.');
    }
    const location = response.headers.get('location');
    if (!location) throw new Error(channel.id + ' returned a redirect without Location.');
    requestUrl = new URL(location, requestUrl).toString();
  }
  throw new Error(channel.id + ' exceeded its redirect limit.');
};

const readResponse = async (response, limit) => {
  if (!response.ok) throw new Error('Unexpected HTTP ' + response.status.toString() + '.');
  const declared = response.headers.get('content-length');
  if (!declared || !/^\d+$/.test(declared) || Number(declared) > limit) {
    throw new Error('Missing, invalid or excessive Content-Length.');
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== Number(declared)) {
    throw new Error('GET body length does not match Content-Length.');
  }
  return bytes;
};

const sha512 = (bytes) => createHash('sha512').update(bytes).digest('base64');
const publicKey = createPublicKey(
  readFileSync('assets/runtime/release-manifest-public-key.pem', 'utf8'),
);

const channelState = [];
for (const channel of channels) {
  const manifestBytes = await readResponse(
    await request(channel, channel.baseUrl + 'release-manifest.json'),
    64 * 1024,
  );
  const signatureBytes = await readResponse(
    await request(channel, channel.baseUrl + 'release-manifest.sig'),
    256,
  );
  if (
    !verify(
      null,
      manifestBytes,
      publicKey,
      Buffer.from(new TextDecoder().decode(signatureBytes).trim(), 'base64'),
    )
  ) {
    throw new Error(channel.id + ' manifest signature is invalid.');
  }
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  if (
    manifest.version !== version ||
    manifest.sources?.github !== githubBase ||
    manifest.sources?.mirror !== mirrorBase
  ) {
    throw new Error(channel.id + ' manifest version or pinned sources are invalid.');
  }
  channelState.push({
    channel,
    manifest,
    manifestBytes,
    signatureBytes,
  });
}

if (
  !Buffer.from(channelState[0].manifestBytes).equals(Buffer.from(channelState[1].manifestBytes)) ||
  !Buffer.from(channelState[0].signatureBytes).equals(Buffer.from(channelState[1].signatureBytes))
) {
  throw new Error('GitHub and mirror manifest bytes differ.');
}

const expectedFiles = new Map(channelState[0].manifest.files.map((entry) => [entry.name, entry]));
for (const requiredName of [installerName, installerName + '.blockmap', 'latest.yml']) {
  if (!expectedFiles.has(requiredName)) {
    throw new Error('Signed manifest is missing ' + requiredName + '.');
  }
}

const reports = [];
for (const state of channelState) {
  const report = {
    cacheControl: {},
    files: {},
    id: state.channel.id,
  };
  for (const [name, bytes] of [
    ['release-manifest.json', state.manifestBytes],
    ['release-manifest.sig', state.signatureBytes],
  ]) {
    const head = await request(state.channel, state.channel.baseUrl + name, { method: 'HEAD' });
    if (head.status !== 200 || head.headers.get('content-length') !== bytes.byteLength.toString()) {
      throw new Error(state.channel.id + ' HEAD failed for ' + name + '.');
    }
    const cacheControl = head.headers.get('cache-control') ?? '';
    if (state.channel.id === 'mirror' && !cacheControl.includes('no-store')) {
      throw new Error('Mirror signed metadata must be no-store.');
    }
    report.cacheControl[name] = cacheControl;
    report.files[name] = { sha512: sha512(bytes), size: bytes.byteLength };
  }
  for (const name of [installerName, installerName + '.blockmap', 'latest.yml']) {
    const expected = expectedFiles.get(name);
    const url = state.channel.baseUrl + encodeURIComponent(name);
    const head = await request(state.channel, url, { method: 'HEAD' });
    if (head.status !== 200 || head.headers.get('content-length') !== expected.size.toString()) {
      throw new Error(state.channel.id + ' HEAD failed for ' + name + '.');
    }
    const cacheControl = head.headers.get('cache-control') ?? '';
    if (state.channel.id === 'mirror') {
      if (name === 'latest.yml' && !cacheControl.includes('no-store')) {
        throw new Error('Mirror latest.yml must be no-store.');
      }
      if (name !== 'latest.yml' && !cacheControl.includes('immutable')) {
        throw new Error('Mirror versioned assets must be immutable.');
      }
    }
    report.cacheControl[name] = cacheControl;

    const response = await request(state.channel, url);
    const declared = response.headers.get('content-length');
    if (response.status !== 200 || declared !== expected.size.toString()) {
      throw new Error(state.channel.id + ' GET headers failed for ' + name + '.');
    }
    const hash = createHash('sha512');
    let size = 0;
    for await (const chunk of response.body) {
      hash.update(chunk);
      size += chunk.byteLength;
      if (size > expected.size) throw new Error('Downloaded file exceeded signed size.');
    }
    const digest = hash.digest('base64');
    if (size !== expected.size || digest !== expected.sha512) {
      throw new Error(state.channel.id + ' SHA-512 failed for ' + name + '.');
    }
    report.files[name] = { sha512: digest, size };
  }

  const installer = expectedFiles.get(installerName);
  const range = await request(state.channel, state.channel.baseUrl + installerName, {
    headers: { range: 'bytes=0-' + (installer.sampleSize - 1).toString() },
  });
  if (
    range.status !== 206 ||
    range.headers.get('content-length') !== installer.sampleSize.toString() ||
    range.headers.get('content-range') !==
      'bytes 0-' + (installer.sampleSize - 1).toString() + '/' + installer.size.toString()
  ) {
    throw new Error(state.channel.id + ' Range response is invalid.');
  }
  const rangeBytes = new Uint8Array(await range.arrayBuffer());
  if (
    rangeBytes.byteLength !== installer.sampleSize ||
    sha512(rangeBytes) !== installer.sampleSha512
  ) {
    throw new Error(state.channel.id + ' Range sample digest is invalid.');
  }
  report.range206 = true;
  reports.push(report);
}

for (const name of [
  installerName,
  installerName + '.blockmap',
  'latest.yml',
  'release-manifest.json',
  'release-manifest.sig',
]) {
  if (reports[0].files[name].sha512 !== reports[1].files[name].sha512) {
    throw new Error('Channel SHA-512 mismatch for ' + name + '.');
  }
}

process.stdout.write(
  JSON.stringify(
    {
      manifestSha512: sha512(channelState[0].manifestBytes),
      reports,
      verified: true,
      version,
    },
    null,
    2,
  ) + '\n',
);
