import assert from 'node:assert/strict';
import test from 'node:test';
import { latestVerificationRun, validateReleaseRef, waitForReleaseCI } from '../scripts/release-ci-gate.mjs';

const sha = 'a'.repeat(40);
const otherSha = 'b'.repeat(40);
const passedRun = { id: 10, head_sha: sha, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success' };
const passedJobs = ['author-verify', 'author-windows-verify', 'author-secret-scan', 'author-required']
    .map(name => ({ name, conclusion: 'success' }));

function apiSequence(responses) {
    const requests = [];
    return {
        requests,
        fetchImpl: async (url, options) => {
            requests.push({ url, options });
            assert.ok(responses.length, 'Unexpected GitHub API request');
            const response = responses.shift();
            return response instanceof Response ? response : Response.json(response);
        },
    };
}

const options = { repository: 'YuanShiJiLoong/author', sha, token: 'test-auth', log: () => {} };

test('publication requires the exact matching version tag and lockfile version', () => {
    const valid = { version: '1.2.57', lockVersion: '1.2.57', publish: true, ref: 'refs/tags/v1.2.57' };
    assert.doesNotThrow(() => validateReleaseRef(valid));
    assert.throws(() => validateReleaseRef({ ...valid, ref: 'refs/heads/main' }), /matching version tag/);
    assert.throws(() => validateReleaseRef({ ...valid, ref: 'refs/tags/v1.2.56' }), /matching version tag/);
    assert.throws(() => validateReleaseRef({ ...valid, lockVersion: '1.2.56' }), /versions must match/);
    assert.throws(() => validateReleaseRef({ ...valid, version: '1.3.0', lockVersion: '1.3.0' }), /1.2.x/);
    assert.doesNotThrow(() => validateReleaseRef({ ...valid, ref: 'refs/heads/main', publish: false }));
});

test('CI from a different commit, branch, or event cannot authorize a release', () => {
    assert.equal(latestVerificationRun([
        { ...passedRun, id: 13, head_sha: otherSha },
        { ...passedRun, id: 12, head_branch: 'feature' },
        { ...passedRun, id: 11, event: 'pull_request' },
    ], sha), null);
});

test('a newer failed CI run cannot reuse an older successful run', async () => {
    const api = apiSequence([{ workflow_runs: [passedRun, { ...passedRun, id: 11, conclusion: 'failure' }] }]);
    await assert.rejects(waitForReleaseCI({ ...options, ...api }), /did not pass/);
    assert.equal(api.requests.length, 1);
});

test('packaging waits for the exact commit and checks all required jobs', async () => {
    const api = apiSequence([
        { workflow_runs: [{ ...passedRun, head_sha: otherSha }] },
        { workflow_runs: [{ ...passedRun, status: 'in_progress', conclusion: null }] },
        { workflow_runs: [passedRun] },
        { jobs: passedJobs },
    ]);
    let waits = 0;
    assert.deepEqual(await waitForReleaseCI({ ...options, ...api, sleepImpl: async () => { waits++; } }), passedRun);
    assert.equal(waits, 2);
    assert.ok(api.requests.slice(0, 3).every(request => new URL(request.url).searchParams.get('head_sha') === sha));
    assert.match(api.requests[3].url, /actions\/runs\/10\/jobs\?filter=latest/);
});

for (const conclusion of ['failure', 'cancelled', 'skipped', 'timed_out']) {
    test(`${conclusion} CI cannot start packaging`, async () => {
        const api = apiSequence([{ workflow_runs: [{ ...passedRun, conclusion }] }]);
        await assert.rejects(waitForReleaseCI({ ...options, ...api }), /did not pass/);
    });
}

test('a missing or skipped required job cannot be hidden by overall workflow success', async () => {
    for (const jobs of [passedJobs.slice(1), passedJobs.map(job => ({ ...job, conclusion: 'skipped' }))]) {
        const api = apiSequence([{ workflow_runs: [passedRun] }, { jobs }]);
        await assert.rejects(waitForReleaseCI({ ...options, ...api }), /Required CI jobs did not pass/);
    }
});

test('a commit with no CI run stops after the bounded wait', async () => {
    let time = 0;
    const api = apiSequence([{ workflow_runs: [] }, { workflow_runs: [] }]);
    await assert.rejects(waitForReleaseCI({
        ...options, ...api, now: () => time, timeoutMs: 20, intervalMs: 10,
        sleepImpl: async ms => { time += ms; },
    }), /Timed out/);
    assert.equal(api.requests.length, 2);
});

test('GitHub API errors fail closed without printing credentials or response bodies', async () => {
    const api = apiSequence([new Response('private response body', { status: 403 })]);
    await assert.rejects(waitForReleaseCI({ ...options, ...api }), error => {
        assert.match(error.message, /403/);
        assert.doesNotMatch(error.message, /test-auth|private response body/);
        return true;
    });
});
