import { appendFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { writeJson } from './mcp-canary.mjs';

export const repository = 'sibi-narendran/common-agent-network';
const workflowPath = '.github/workflows/deploy-cloudflare.yml';

export function deploymentRunId(eventName, event, repo, ref) {
  if (repo !== repository || ref !== 'refs/heads/main')
    throw new Error('Canary controller must run on upstream main');
  let id;
  if (eventName === 'workflow_run') {
    validateDeployment(event.workflow_run);
    id = event.workflow_run.id;
  } else if (eventName === 'workflow_dispatch') {
    id = Number(event.inputs?.deployment_run_id);
  } else {
    throw new Error('Unsupported canary trigger');
  }
  if (!Number.isSafeInteger(id) || id <= 0)
    throw new Error('A numeric successful deployment run ID is required');
  return id;
}

export function validateDeployment(run) {
  if (
    !run ||
    run.repository?.full_name !== repository ||
    run.head_repository?.full_name !== repository ||
    run.head_branch !== 'main' ||
    run.path !== workflowPath ||
    !['push', 'workflow_dispatch'].includes(run.event) ||
    run.status !== 'completed' ||
    run.conclusion !== 'success' ||
    !/^[a-f0-9]{40}$/.test(run.head_sha || '') ||
    !Number.isSafeInteger(run.id) ||
    run.id <= 0 ||
    !Number.isSafeInteger(run.run_attempt) ||
    run.run_attempt <= 0 ||
    !Number.isFinite(Date.parse(run.updated_at))
  )
    throw new Error('Expected a successful upstream main deployment');
  return {
    runId: run.id,
    runAttempt: run.run_attempt,
    sourceSha: run.head_sha,
    completedAt: run.updated_at,
    runUrl: `https://github.com/${repository}/actions/runs/${run.id}`,
  };
}

export function assertCurrentDeployment(selected, runs) {
  // Fail closed on a concurrent deploy or a missing selected run.
  if (!Array.isArray(runs))
    throw new Error('Cannot establish the current deployment from run history');
  let found = false;
  for (const run of runs) {
    if (run.status !== 'completed')
      throw new Error(
        'A deployment is pending or in progress; retry after it settles',
      );
    if (run.conclusion !== 'success') continue;
    const other = validateDeployment(run);
    if (other.runId === selected.runId) {
      if (
        other.runAttempt !== selected.runAttempt ||
        other.sourceSha !== selected.sourceSha
      )
        throw new Error('Deployment run changed during verification');
      found = true;
    } else if (
      Date.parse(other.completedAt) >= Date.parse(selected.completedAt)
    ) {
      throw new Error('Selected deployment has been superseded');
    }
  }
  if (!found)
    throw new Error('Selected deployment is absent from recent run history');
}

export async function resolveDeployment({
  eventName,
  event,
  repo,
  ref,
  fetchImpl = fetch,
}) {
  const id = deploymentRunId(eventName, event, repo, ref);
  async function get(path) {
    // Public metadata only: no token, secrets, redirects, arbitrary hosts or writes.
    const response = await fetchImpl(
      `https://api.github.com/repos/${repository}/${path}`,
      {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'agent-commons-canary',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!response.ok)
      throw new Error(`Deployment metadata HTTP ${response.status}`);
    return response.json();
  }
  const run = await get(`actions/runs/${id}`);
  const selected = validateDeployment(run);
  if (selected.runId !== id) throw new Error('Deployment run ID mismatch');
  if (
    eventName === 'workflow_run' &&
    (event.workflow_run.head_sha !== selected.sourceSha ||
      event.workflow_run.run_attempt !== selected.runAttempt)
  )
    throw new Error('Trigger and deployment record differ');
  const history = await get(
    'actions/workflows/deploy-cloudflare.yml/runs?branch=main&per_page=100',
  );
  assertCurrentDeployment(selected, history.workflow_runs);
  return selected;
}

async function main() {
  const evidencePath = 'work/mcp-deployment.json';
  let evidence;
  try {
    const event = JSON.parse(
      await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'),
    );
    const selected = await resolveDeployment({
      eventName: process.env.GITHUB_EVENT_NAME,
      event,
      repo: process.env.GITHUB_REPOSITORY,
      ref: process.env.GITHUB_REF,
    });
    const previous = process.argv.includes('--verify')
      ? JSON.parse(await readFile(evidencePath, 'utf8'))
      : undefined;
    if (
      previous &&
      (previous.sourceSha !== selected.sourceSha ||
        previous.runId !== selected.runId ||
        previous.runAttempt !== selected.runAttempt)
    )
      throw new Error('Deployment changed during canary');
    evidence = {
      ...selected,
      status: 'passed',
      checkedAt: new Date().toISOString(),
    };
    if (!previous)
      await appendFile(
        process.env.GITHUB_OUTPUT,
        `sha=${selected.sourceSha}\n`,
      );
  } catch (error) {
    evidence = {
      status: 'failed',
      error: error.message,
      checkedAt: new Date().toISOString(),
    };
    process.exitCode = 1;
  }
  await writeJson(evidencePath, evidence);
  console.log(
    `Deployment association ${evidence.status}; evidence: ${evidencePath}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
