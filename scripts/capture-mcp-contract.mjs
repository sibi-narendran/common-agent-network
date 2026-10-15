import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { finished } from 'node:stream/promises';
import { runCanary, writeJson } from './mcp-canary.mjs';

await mkdir('work', { recursive: true });
await rm('work/mcp-expected.json', { force: true });
// Use a free loopback port and wait for this child's ready message, so an
// unrelated process cannot be mistaken for the just-built Worker.
const probe = createServer();
await new Promise((resolve, reject) => {
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', resolve);
});
const address = probe.address();
if (!address || typeof address === 'string')
  throw new Error('No local TCP port');
const port = address.port;
await new Promise((resolve, reject) =>
  probe.close((error) => (error ? reject(error) : resolve())),
);
const state = await mkdtemp('work/mcp-canary-state-');
const log = createWriteStream('work/mcp-local-worker.log');
const sourceSha =
  process.env.MCP_SOURCE_SHA ||
  process.env.GITHUB_SHA ||
  execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const env = {
  ...process.env,
  WRANGLER_SEND_METRICS: 'false',
  WRANGLER_WRITE_LOGS: 'false',
  MINIFLARE_REGISTRY_PATH: `${state}/registry`,
};
delete env.CLOUDFLARE_API_TOKEN;
delete env.CLOUDFLARE_ACCOUNT_ID;
const child = spawn(
  process.execPath,
  [
    'node_modules/wrangler/bin/wrangler.js',
    'dev',
    '--config',
    'dist/server/wrangler.json',
    '--local',
    '--ip',
    '127.0.0.1',
    '--port',
    String(port),
    '--persist-to',
    state,
  ],
  { env, stdio: ['ignore', 'pipe', 'pipe'] },
);
child.stdout.pipe(log, { end: false });
child.stderr.pipe(log, { end: false });
let childError;
child.on('error', (error) => {
  childError = error;
});
try {
  await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(
      () => finish(new Error('Local Worker startup timed out')),
      20000,
    );
    const onExit = () => finish(new Error('Local Worker exited before ready'));
    const onData = (chunk) => {
      output = `${output}${chunk}`.slice(-4096);
      if (output.includes(`Ready on http://127.0.0.1:${port}`)) finish();
    };
    function finish(error) {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.off('exit', onExit);
      child.off('error', finish);
      if (error) reject(error);
      else resolve();
    }
    child.stdout.on('data', onData);
    child.once('exit', onExit);
    child.once('error', finish);
  });
  const { evidence, snapshot } = await runCanary({
    endpoint: `http://127.0.0.1:${port}/mcp`,
    sourceSha,
    attempts: 10,
    timeoutMs: 3000,
    budgetMs: 60000,
    delayMs: 500,
  });
  await writeJson('work/mcp-local-canary.json', evidence);
  if (childError || !snapshot || child.exitCode !== null)
    throw new Error(
      'Local built Worker canary failed; see work/mcp-local-canary.json and work/mcp-local-worker.log',
    );
  await writeJson('work/mcp-expected.json', snapshot);
  console.log(
    `Captured ${snapshot.tools.length} tools from the built Worker at ${sourceSha}`,
  );
} catch (error) {
  await writeJson('work/mcp-local-startup-error.json', {
    status: 'failed',
    sourceSha,
    error: error.message,
  });
  throw error;
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit').catch(() => {});
    child.kill('SIGTERM');
    await Promise.race([exited, sleep(3000)]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
  }
  log.end();
  await finished(log);
  await rm(state, { recursive: true, force: true });
}
