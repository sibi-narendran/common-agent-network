import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  assertCurrentDeployment,
  deploymentRunId,
  repository,
  resolveDeployment,
  validateDeployment,
} from './mcp-deployment.mjs';

const run = {
  id: 42,
  run_attempt: 1,
  head_sha: 'a'.repeat(40),
  head_branch: 'main',
  repository: { full_name: repository },
  head_repository: { full_name: repository },
  path: '.github/workflows/deploy-cloudflare.yml',
  event: 'push',
  status: 'completed',
  conclusion: 'success',
  updated_at: '2026-10-15T00:00:00Z',
};
const context = {
  eventName: 'workflow_run',
  event: { workflow_run: run },
  repo: repository,
  ref: 'refs/heads/main',
};

for (const [name, change] of Object.entries({
  'fork source': {
    head_repository: { full_name: 'fork/common-agent-network' },
  },
  'foreign repository': { repository: { full_name: 'other/repo' } },
  'PR workflow': { event: 'pull_request' },
  'non-main deploy': { head_branch: 'feature' },
  'other workflow': { path: '.github/workflows/validate-pr.yml' },
  'failed deploy': { conclusion: 'failure' },
  'unfinished deploy': { status: 'in_progress' },
  'untrusted SHA': { head_sha: 'main; echo sentinel' },
})) {
  test(`deployment association rejects ${name}`, () => {
    assert.throws(
      () => validateDeployment({ ...run, ...change }),
      /successful upstream main/,
    );
  });
}

test('manual dispatch requires upstream main and an explicit deployment run ID', () => {
  assert.equal(
    deploymentRunId(
      'workflow_dispatch',
      { inputs: { deployment_run_id: '42' } },
      repository,
      'refs/heads/main',
    ),
    42,
  );
  for (const id of [undefined, '', 'main', '42; echo sentinel', '-1'])
    assert.throws(
      () =>
        deploymentRunId(
          'workflow_dispatch',
          { inputs: { deployment_run_id: id } },
          repository,
          'refs/heads/main',
        ),
      /numeric/,
    );
  for (const [repo, ref] of [
    ['fork/repo', 'refs/heads/main'],
    [repository, 'refs/heads/feature'],
  ])
    assert.throws(
      () =>
        deploymentRunId(
          'workflow_dispatch',
          { inputs: { deployment_run_id: '42' } },
          repo,
          ref,
        ),
      /upstream main/,
    );
});

test('a later default-branch SHA does not replace the deployed SHA', async () => {
  const requests = [];
  const selected = await resolveDeployment({
    ...context,
    fetchImpl: async (url, options) => {
      requests.push(url);
      assert.equal(options.method, undefined);
      assert.equal(options.redirect, 'error');
      assert.equal(
        Object.keys(options.headers).some((key) => /authorization/i.test(key)),
        false,
      );
      assert.match(
        url,
        /^https:\/\/api\.github\.com\/repos\/sibi-narendran\/common-agent-network\//,
      );
      return {
        ok: true,
        json: async () =>
          requests.length === 1 ? run : { workflow_runs: [run] },
      };
    },
  });
  assert.equal(selected.sourceSha, run.head_sha);
  assert.equal(requests.length, 2);
});

test('manual deployment lookup fails closed on metadata errors', async () => {
  await assert.rejects(
    resolveDeployment({
      ...context,
      fetchImpl: async () => ({ ok: false, status: 403 }),
    }),
    /HTTP 403/,
  );
});

test('rerun attempt changes invalidate the original trigger', async () => {
  await assert.rejects(
    resolveDeployment({
      ...context,
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ ...run, run_attempt: 2 }),
      }),
    }),
    /Trigger and deployment record differ/,
  );
});

test('stale, missing, rerun and concurrent deployments cannot pass as current', () => {
  const selected = validateDeployment(run);
  assert.doesNotThrow(() => assertCurrentDeployment(selected, [run]));
  assert.throws(() => assertCurrentDeployment(selected, []), /absent/);
  assert.throws(
    () =>
      assertCurrentDeployment(selected, [
        run,
        { ...run, id: 43, updated_at: '2026-10-15T00:01:00Z' },
      ]),
    /superseded/,
  );
  assert.throws(
    () =>
      assertCurrentDeployment(selected, [{ ...run, status: 'in_progress' }]),
    /in progress/,
  );
  assert.throws(
    () => assertCurrentDeployment(selected, [{ ...run, run_attempt: 2 }]),
    /changed/,
  );
});

test('canary workflow isolates the deployed source from credentials and caches', async () => {
  const yaml = await readFile('.github/workflows/mcp-canary.yml', 'utf8');
  assert.doesNotMatch(
    yaml,
    /secrets\s*(?:\.|\[)|secrets:\s*inherit|id-token:|pull_request_target:|cache:/,
  );
  assert.match(yaml, /permissions:\n  contents: read\n/);
  assert.match(yaml, /ref: \$\{\{ steps.deployment.outputs.sha \}\}/);
  assert.equal((yaml.match(/persist-credentials: false/g) || []).length, 2);
  assert.match(yaml, /github.ref == 'refs\/heads\/main'/);
  assert.match(
    yaml,
    /MCP_SOURCE_SHA: \$\{\{ steps.deployment.outputs.sha \}\}/,
  );
  assert.match(yaml, /node scripts\/mcp-deployment.mjs --verify/);
});
