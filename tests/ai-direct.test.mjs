import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { readAiEvents } from '../app/lib/ai-stream.js';

let instance = 0;
const request = signal => ({ method: 'POST', signal, body: JSON.stringify({ apiConfig: { apiKey: 'synthetic', baseUrl: 'https://example.test/v1', model: 'synthetic' }, userPrompt: 'synthetic' }) });
const sse = data => `data: ${JSON.stringify(data)}\n\n`;

async function fixture(t, timeout = 120000) {
    const previous = globalThis.window;
    globalThis.window = { localStorage: { getItem: () => '1' } };
    t.after(() => { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; });
    const id = ++instance;
    const moduleUrl = new URL('../app/lib/ai-direct.js', import.meta.url).href;
    const lifecycleUrl = new URL('../app/lib/ai-request-lifecycle.js', import.meta.url).href;
    const mockUrl = `data:text/javascript,${encodeURIComponent(`
        import { createGenerationLifecycle as create, generationAbortResponse } from '${lifecycleUrl}';
        export { generationAbortResponse };
        export const createGenerationLifecycle = signal => create(signal, ${timeout});
        export const apiPath = value => value;
        export const IS_OFFICIAL_WEB = true;
        export const rotateKey = value => value;
        export const applyContentSafety = value => value;
        // fixture ${id}
    `)}`;
    const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
        if (context.parentURL?.startsWith(moduleUrl) && !['ai-stream.js', 'ai-model-rules.js', 'ai-upstream-errors.js'].some(name => specifier.endsWith(name))) return { url: mockUrl, shortCircuit: true };
        return nextResolve(specifier, context);
    } });
    try { return await import(`${moduleUrl}?fixture=${id}`); }
    finally { hooks.deregister(); }
}

test('direct cancellation before headers does not trigger a proxy retry', async t => {
    const { aiFetch } = await fixture(t);
    let signal;
    const mocked = t.mock.method(globalThis, 'fetch', async (_url, options) => {
        signal = options.signal;
        return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const controller = new AbortController();
    const response = aiFetch('/api/ai', request(controller.signal));
    controller.abort();
    await assert.rejects(response, { name: 'AbortError' });
    assert.equal(signal.aborted, true);
    assert.equal(mocked.mock.callCount(), 1);
});

test('direct timeout is localized by code and never retries through the proxy', async t => {
    const { aiFetch } = await fixture(t, 10);
    const mocked = t.mock.method(globalThis, 'fetch', async (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
    const response = await aiFetch('/api/ai', request());
    assert.equal(response.status, 504);
    assert.equal((await response.json()).code, 'AI_GENERATION_TIMEOUT');
    assert.equal(mocked.mock.callCount(), 1);
});

test('direct partial response followed by EOF fails without issuing another generation', async t => {
    const { aiFetch } = await fixture(t);
    const mocked = t.mock.method(globalThis, 'fetch', async () => new Response(sse({ choices: [{ delta: { content: 'partial' } }] })));
    const events = [];
    const response = await aiFetch('/api/ai', request());
    await assert.rejects(async () => { for await (const event of readAiEvents(response)) events.push(event); }, { code: 'AI_STREAM_INCOMPLETE' });
    assert.equal(events[0].text, 'partial');
    assert.equal(mocked.mock.callCount(), 1);
});

test('direct streaming cancellation aborts the fetch and releases its reader', async t => {
    const { aiFetch } = await fixture(t);
    let cancelled = false, signal;
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        signal = options.signal;
        return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    });
    const response = await aiFetch('/api/ai', request());
    await delay(0);
    await response.body.cancel();
    assert.equal(signal.aborted, true);
    assert.equal(cancelled, true);
});

test('connection failure before direct response still uses the existing proxy fallback', async t => {
    const { aiFetch } = await fixture(t);
    const calls = [];
    t.mock.method(globalThis, 'fetch', async url => {
        calls.push(url);
        if (calls.length === 1) throw new TypeError('Synthetic CORS failure');
        return new Response('data: [DONE]\n\n');
    });
    const response = await aiFetch('/api/ai', request());
    await response.text();
    assert.deepEqual(calls, ['https://example.test/v1/chat/completions', '/api/ai']);
});

test('direct connection test reports insufficient balance by code without a proxy retry', async t => {
    const { testAiConnection } = await fixture(t);
    const calls = [];
    t.mock.method(globalThis, 'fetch', async url => {
        calls.push(url);
        return new Response(JSON.stringify({ error: { message: 'Insufficient Balance', type: 'unknown_error', code: 'invalid_request_error' } }), { status: 402 });
    });
    const result = await testAiConnection({ provider: 'deepseek', apiKey: 'synthetic', baseUrl: 'https://example.test/v1', model: 'synthetic' });
    assert.equal(result.success, false);
    assert.equal(result.code, 'AI_INSUFFICIENT_QUOTA');
    assert.deepEqual(calls, ['https://example.test/v1/chat/completions']);
});
