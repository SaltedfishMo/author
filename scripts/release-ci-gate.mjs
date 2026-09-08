import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const REQUIRED_JOBS = ['author-verify', 'author-windows-verify', 'author-secret-scan', 'author-required'];

export function validateReleaseRef({ ref, version, lockVersion, publish }) {
    if (!/^1\.2\.\d+$/.test(version) || lockVersion !== version) {
        throw new Error('Release package versions must match and use the 1.2.x release series.');
    }
    if (publish && ref !== `refs/tags/v${version}`) {
        throw new Error(`Publication requires the matching version tag v${version}.`);
    }
}

export function latestVerificationRun(runs, sha) {
    return runs
        .filter(run => run.head_sha === sha && run.event === 'push' && run.head_branch === 'main')
        .sort((a, b) => b.id - a.id)[0] || null;
}

export async function waitForReleaseCI({
    repository, sha, token, fetchImpl = fetch, sleepImpl = sleep,
    now = Date.now, timeoutMs = 15 * 60 * 1000, intervalMs = 10000, log = console.log,
}) {
    if (repository !== 'YuanShiJiLoong/author' || !/^[a-f0-9]{40}$/.test(sha) || !token) {
        throw new Error('A valid repository, exact commit SHA, and GitHub token are required.');
    }
    const deadline = now() + timeoutMs;
    const headers = {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
    };
    async function get(route) {
        const response = await fetchImpl(`https://api.github.com/repos/${repository}/${route}`, {
            headers, signal: AbortSignal.timeout(30000),
        });
        if (!response.ok) throw new Error(`GitHub CI status request failed (${response.status}).`);
        return response.json();
    }
    let previousStatus;
    while (now() < deadline) {
        const result = await get(`actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&branch=main&per_page=100`);
        const run = latestVerificationRun(result.workflow_runs || [], sha);
        const status = run ? `${run.id}:${run.status}:${run.conclusion || ''}` : 'waiting-for-ci';
        if (status !== previousStatus) {
            log(run ? `CI ${run.id}: ${run.status}${run.conclusion ? ` (${run.conclusion})` : ''}` : 'Waiting for the main-branch CI run for this commit.');
            previousStatus = status;
        }
        if (run?.status === 'completed') {
            if (run.conclusion !== 'success') {
                throw new Error(`CI ${run.id} did not pass. Packaging has not started; fix the commit before releasing.`);
            }
            const { jobs = [] } = await get(`actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
            const missing = REQUIRED_JOBS.filter(name => !jobs.some(job => job.name === name && job.conclusion === 'success'));
            if (missing.length) throw new Error(`Required CI jobs did not pass: ${missing.join(', ')}.`);
            log(`Verified commit ${sha}: all required checks passed in CI ${run.id}.`);
            return run;
        }
        await sleepImpl(Math.min(intervalMs, Math.max(0, deadline - now())));
    }
    throw new Error('Timed out waiting for successful CI. Push this commit to main and wait for CI before tagging.');
}

async function main() {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
    validateReleaseRef({
        ref: process.env.GITHUB_REF, version: pkg.version, lockVersion: lock.version,
        publish: process.env.RELEASE_PUBLISH === 'true',
    });
    await waitForReleaseCI({
        repository: process.env.GITHUB_REPOSITORY,
        sha: process.env.GITHUB_SHA,
        token: process.env.GITHUB_TOKEN,
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
