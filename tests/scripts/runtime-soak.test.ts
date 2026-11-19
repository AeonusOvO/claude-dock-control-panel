import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { expect, it } from 'vitest';

it('completes every requested virtual minute even if the wall clock jumps ahead', () => {
  const script = path.resolve('scripts/smoke/runtime-soak.cjs');
  const fixture = [
    'let now = 1000;',
    'Date.now = () => (now += 9000);',
    "process.argv.push('--accelerated', '--hours=1');",
    'require(process.argv[1]);',
  ].join('\n');
  const output = execFileSync(process.execPath, ['-e', fixture, script], { encoding: 'utf8' });
  expect(JSON.parse(output)).toMatchObject({
    createdEvents: 60,
    virtualElapsedMs: 3_600_000,
    recycledServers: 2,
  });
});
