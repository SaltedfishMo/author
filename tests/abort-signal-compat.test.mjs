import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';

import { anySignal, timeoutSignal } from '../app/lib/abort-signal-compat.js';

// Reproduce the browsers that broke cloud sync: AbortSignal.any() shipped in
// Chrome 116 / Safari 17.4 / Firefox 124, so iOS 16, iOS 17.0-17.3 and older
// embedded Chromium have AbortController but not the static combinators.
function withoutNativeStatics(t, names) {
    for (const name of names) {
        const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, name);
        delete AbortSignal[name];
        t.after(() => { if (descriptor) Object.defineProperty(AbortSignal, name, descriptor); });
    }
}

// Minimal signal stand-in that records its listeners, so the fallback can be
// checked for listeners left behind on long-lived session signals.
function trackedSignal() {
    const listeners = new Set();
    const signal = {
        aborted: false,
        reason: undefined,
        listeners,
        addEventListener: (type, listener) => listeners.add(listener),
        removeEventListener: (type, listener) => listeners.delete(listener),
        abort(reason) {
            signal.aborted = true;
            signal.reason = reason;
            for (const listener of [...listeners]) listener({ target: signal });
        },
    };
    return signal;
}

test('browsers without AbortSignal.any still combine signals and keep the reason', t => {
    withoutNativeStatics(t, ['any']);
    const auth = new AbortController();
    const sync = new AbortController();
    const combined = anySignal([auth.signal, sync.signal]);
    assert.equal(combined.aborted, false);
    const reason = new Error('同步已停止');
    sync.abort(reason);
    assert.equal(combined.aborted, true);
    assert.equal(combined.reason, reason);
    assert.throws(() => combined.throwIfAborted(), /同步已停止/);
});

test('a source that already aborted produces an aborted signal without listeners', t => {
    withoutNativeStatics(t, ['any']);
    const signedOut = trackedSignal();
    signedOut.abort(new Error('signed out'));
    const pending = trackedSignal();
    const combined = anySignal([signedOut, pending]);
    assert.equal(combined.aborted, true);
    assert.equal(combined.reason.message, 'signed out');
    assert.equal(pending.listeners.size, 0);
});

test('the fallback drops its listeners once aborted and ignores later sources', t => {
    withoutNativeStatics(t, ['any']);
    const auth = trackedSignal();
    const sync = trackedSignal();
    const combined = anySignal([auth, sync]);
    assert.equal(auth.listeners.size, 1);
    auth.abort(new Error('first'));
    sync.abort(new Error('second'));
    assert.equal(combined.reason.message, 'first');
    assert.equal(auth.listeners.size, 0);
    assert.equal(sync.listeners.size, 0);
});

test('a single source is reused as-is and an empty list never aborts', t => {
    withoutNativeStatics(t, ['any']);
    const only = trackedSignal();
    assert.equal(anySignal([only, null, undefined]), only);
    assert.equal(only.listeners.size, 0);
    assert.equal(anySignal([]).aborted, false);
});

test('browsers without AbortSignal.timeout still abort with a TimeoutError', async t => {
    withoutNativeStatics(t, ['timeout']);
    const signal = timeoutSignal(1);
    assert.equal(signal.aborted, false);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(signal.aborted, true);
    assert.equal(signal.reason.name, 'TimeoutError');
});

test('native implementations are used when the browser provides them', () => {
    assert.equal(typeof AbortSignal.any, 'function');
    const source = new AbortController();
    const combined = anySignal([source.signal]);
    assert.notEqual(combined, source.signal);
    source.abort(new Error('native'));
    assert.equal(combined.reason.message, 'native');
});

// Client modules must go through the compat layer: a direct AbortSignal.any()
// call is a runtime TypeError on those browsers and breaks the whole feature.
test('client code never calls the AbortSignal statics directly', async () => {
    const compat = 'abort-signal-compat.js';
    async function visit(directory) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const location = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
            if (entry.isDirectory()) await visit(location);
            else if (entry.name.endsWith('.js') && entry.name !== compat) {
                const source = await readFile(location, 'utf8');
                assert.doesNotMatch(source, /AbortSignal\.(any|timeout)\s*\(/, `${location.href} must use ${compat}`);
            }
        }
    }
    for (const directory of ['../app/lib/', '../app/components/', '../app/store/']) {
        await visit(new URL(directory, import.meta.url));
    }
});
