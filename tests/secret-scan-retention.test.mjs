import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { pruneScanDirectories, retainedScans } from '../scripts/security/scan-retention.mjs';

function scansRoot() {
    return mkdtempSync(path.join(tmpdir(), 'author-scan-retention-'));
}

// Scan directories are ordered by modification time, so ages are stamped explicitly rather than raced.
function scanDirectory(root, name, ageMinutes) {
    const directory = path.join(root, name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'summary.json'), '{}\n');
    const seconds = Math.floor(Date.now() / 1000) - ageMinutes * 60;
    utimesSync(directory, seconds, seconds);
    return directory;
}

// mkdtempSync always appends six characters; a fixture that misses that would be skipped, silently
// passing every assertion below for the wrong reason.
function realScan(root, prefix, suffix, ageMinutes) {
    assert.equal(suffix.length, 6, `fixture ${prefix}-${suffix} must use a six character suffix`);
    return scanDirectory(root, `${prefix}-${suffix}`, ageMinutes);
}

test('keeps the newest directories of every scan type and removes the rest', () => {
    const root = scansRoot();
    const artifacts = ['aaaaaa', 'bbbbbb', 'cccccc', 'dddddd', 'eeeeee']
        .map((suffix, index) => realScan(root, 'artifact', suffix, index));
    const trees = ['ffffff', 'gggggg'].map((suffix, index) => realScan(root, 'tree', suffix, index));
    const history = realScan(root, 'history', 'hhhhhh', 500);

    const removed = pruneScanDirectories(root);

    assert.equal(retainedScans, 3);
    // The three newest artifact runs survive; the two oldest go.
    assert.deepEqual(removed.map(directory => path.basename(directory)).sort(), ['artifact-dddddd', 'artifact-eeeeee']);
    for (const directory of artifacts.slice(0, 3)) assert.ok(existsSync(directory), `${directory} should be kept`);
    for (const directory of artifacts.slice(3)) assert.ok(!existsSync(directory), `${directory} should be removed`);
    // Types below the limit are untouched, so a rare history run is never evicted by frequent artifact runs.
    for (const directory of trees) assert.ok(existsSync(directory));
    assert.ok(existsSync(history));
});

test('never removes entries this pipeline did not create', () => {
    const root = scansRoot();
    const untouched = [
        scanDirectory(root, 'notes', 100),
        scanDirectory(root, 'artifact-short', 100),
        scanDirectory(root, 'artifact-toolongasuffix', 100),
        scanDirectory(root, 'artifact-with!ba', 100),
        scanDirectory(root, 'unknown-aaaaaa', 100),
    ];
    const stray = path.join(root, 'artifact-aaaaaa.txt');
    writeFileSync(stray, 'not a scan\n');
    for (let index = 0; index <= retainedScans; index += 1) realScan(root, 'artifact', `scan00${index}`.slice(-6), index);

    const removed = pruneScanDirectories(root);

    assert.equal(removed.length, 1);
    for (const directory of untouched) assert.ok(existsSync(directory), `${directory} should be kept`);
    assert.ok(existsSync(stray));
});

test('keeps the run in progress even when it is older than the retained ones', () => {
    const root = scansRoot();
    const inProgress = realScan(root, 'docker', 'zzzzzz', 900);
    for (let index = 0; index <= retainedScans; index += 1) realScan(root, 'docker', `fresh${index}`, index);

    const removed = pruneScanDirectories(root, { protect: [inProgress, undefined] });

    assert.ok(existsSync(inProgress));
    assert.deepEqual(removed.map(directory => path.basename(directory)), [`docker-fresh${retainedScans}`]);
});

test('leaves a symlinked scan directory alone rather than deleting through it', (t) => {
    const root = scansRoot();
    const payload = realScan(scansRoot(), 'artifact', 'target', 0);
    const link = path.join(root, 'artifact-llllll');
    try { symlinkSync(payload, link, 'junction'); } catch { return t.skip('symlinks are not permitted here'); }
    for (let index = 0; index <= retainedScans; index += 1) realScan(root, 'artifact', `real0${index}`, index + 1);

    const removed = pruneScanDirectories(root);

    assert.ok(existsSync(payload), 'the link target must survive');
    assert.ok(existsSync(link), 'the link itself is not ours to remove');
    assert.deepEqual(removed.map(directory => path.basename(directory)), [`artifact-real0${retainedScans}`]);
});

test('reports nothing when no scan has ever run', () => {
    assert.deepEqual(pruneScanDirectories(path.join(scansRoot(), 'never-created')), []);
});
