import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { git, repositoryFiles } from '../../scripts/repository-files.mjs';
import { scanWithGitleaks, snapshotSource, checkSecrets } from '../../scripts/check-secrets.mjs';
import { installGitleaks, installArtifactConfig } from '../../scripts/security/gitleaks.mjs';
import { expectedNextRuntimeKey } from '../../scripts/security/artifact-policy.mjs';

// Generated, never valid credentials. Fixtures and metadata stay in the ignored workspace.
const fixtures = path.resolve('.tmp/secret-scanner-tests');
mkdirSync(fixtures, { recursive: true });
const run = mkdtempSync(path.join(fixtures, 'run-'));
const executable = await installGitleaks();
await installArtifactConfig();
const canary = ['ghp', randomBytes(18).toString('hex')].join('_');

function directory(name) {
    const dir = path.join(run, name);
    mkdirSync(dir);
    return dir;
}

function scan(mode, target, name) {
    const reportDirectory = directory(name);
    const findings = scanWithGitleaks(executable, { mode, target, reportDirectory });
    const report = readFileSync(path.join(reportDirectory, 'findings.json'), 'utf8');
    assert.equal(report.includes(canary), false, 'report must not contain the synthetic token');
    for (const finding of findings) assert.deepEqual(Object.keys(finding).sort(), ['column', 'commit', 'endColumn', 'endLine', 'file', 'line', 'rule']);
    return findings;
}

test('current source detects tracked ignored files and nonignored new files, without inline bypass', () => {
    const repo = directory('source-repo');
    git(repo, ['init', '-q']);
    writeFileSync(path.join(repo, '.gitignore'), 'tracked.txt\nignored.txt\n');
    writeFileSync(path.join(repo, 'tracked.txt'), `token = '${canary}' // gitleaks:allow\n`);
    writeFileSync(path.join(repo, 'new.txt'), `token = '${canary}'\n`);
    writeFileSync(path.join(repo, 'ignored.txt'), 'local synthetic data');
    git(repo, ['add', '-f', 'tracked.txt']);
    const files = repositoryFiles(repo);
    assert.ok(files.includes('tracked.txt') && files.includes('new.txt'));
    assert.equal(files.includes('ignored.txt'), false);
    const snapshot = directory('source-snapshot');
    snapshotSource(repo, snapshot);
    const findings = scan('tree', snapshot, 'source-report');
    assert.ok(findings.some(f => f.file.endsWith('tracked.txt')));
    assert.ok(findings.some(f => f.file.endsWith('new.txt')));
});

test('history detects a secret removed from the latest tree', () => {
    const repo = directory('history-repo');
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.name', 'Synthetic scanner test']);
    git(repo, ['config', 'user.email', 'scanner@example.invalid']);
    git(repo, ['config', 'core.hooksPath', path.join(run, 'no-hooks')]);
    writeFileSync(path.join(repo, 'history.txt'), `token = '${canary}'\n`);
    git(repo, ['add', 'history.txt']);
    git(repo, ['-c', 'commit.gpgSign=false', 'commit', '-qm', 'Synthetic test secret']);
    writeFileSync(path.join(repo, 'history.txt'), 'clean current contents\n');
    git(repo, ['add', 'history.txt']);
    git(repo, ['-c', 'commit.gpgSign=false', 'commit', '-qm', 'Replace synthetic secret']);
    const snapshot = directory('history-current');
    snapshotSource(repo, snapshot);
    assert.equal(scan('tree', snapshot, 'history-current-report').length, 0);
    assert.ok(scan('history', repo, 'history-report').some(f => f.commit.length === 40));
});

test('packaged files and nested tar payloads are inspected', () => {
    const artifact = directory('artifact');
    const payload = directory('archive-payload');
    writeFileSync(path.join(artifact, 'bundle.js'), `const token = '${canary}';\n`);
    writeFileSync(path.join(payload, 'nested.txt'), `token = '${canary}'\n`);
    const packed = spawnSync('tar', ['-cf', path.join(artifact, 'payload.tar'), '-C', payload, 'nested.txt']);
    assert.equal(packed.status, 0);
    const findings = scan('artifact', artifact, 'artifact-report');
    assert.ok(findings.some(f => f.file.includes('bundle.js')));
    assert.ok(findings.some(f => f.file.includes('payload.tar')));
});

test('missing scanner and shallow history fail closed', async () => {
    assert.throws(() => scanWithGitleaks(path.join(run, 'missing-scanner'), {
        mode: 'artifact', target: run, reportDirectory: directory('missing-report'),
    }), /NOT a clean scan/);
    const shallow = directory('shallow');
    const source = path.join(run, 'history-repo');
    git(run, ['clone', '--depth', '1', `file:///${source.replaceAll('\\', '/').replace(/^\//, '')}`, shallow]);
    await assert.rejects(checkSecrets('history', undefined, shallow), /full checkout/);
});

test('only exact unused Next.js runtime fields are classified; adjacent credentials still fail', () => {
    const artifact = directory('next-artifact');
    const next = path.join(artifact, '.next');
    mkdirSync(path.join(next, 'server'), { recursive: true });
    const manifest = path.join(next, 'server/server-reference-manifest.json');
    // Fixed synthetic values keep this policy test independent of random-key
    // entropy and prefixes that the pinned scanner's generic rule may not match.
    const runtimeKey = (name, encoding) => createHash('sha256').update(`synthetic-next-runtime:${name}`).digest(encoding);
    const actions = { node: {}, edge: {}, encryptionKey: runtimeKey('actions', 'base64') };
    writeFileSync(manifest, JSON.stringify(actions, null, 2));
    writeFileSync(path.join(next, 'prerender-manifest.json'), JSON.stringify({ preview: {
        previewModeSigningKey: runtimeKey('preview-signing', 'hex'),
        previewModeEncryptionKey: runtimeKey('preview-encryption', 'hex'),
        token: canary,
    } }, null, 2));
    const findings = scan('artifact', artifact, 'next-report');
    assert.equal(findings.filter(f => expectedNextRuntimeKey(f, artifact)).length, 3);
    assert.ok(findings.some(f => f.rule === 'github-pat' && !expectedNextRuntimeKey(f, artifact)));
    actions.node.syntheticAction = {};
    writeFileSync(manifest, JSON.stringify(actions, null, 2));
    assert.equal(findings.filter(f => expectedNextRuntimeKey(f, artifact)).length, 0, 'enabled Server Actions must force a policy review');
});
