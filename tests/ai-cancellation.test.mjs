import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { readAiEvents } from '../app/lib/ai-stream.js';
import { listenLocal } from './helpers/local-server.mjs';

let instance = 0;
const sse = value => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
const openText = text => ({ choices: [{ delta: { content: text } }] });
const toolReply = provider => provider === 'claude'
    ? { content: [{ type: 'tool_use', id: 'search-1', name: 'web_search', input: { query: 'synthetic' } }, { type: 'tool_use', id: 'search-2', name: 'web_search', input: { query: 'second' } }], stop_reason: 'tool_use' }
    : { choices: [{ message: { tool_calls: [1, 2].map(id => ({ id: `search-${id}`, function: { name: 'web_search', arguments: '{"query":"synthetic"}' } })) }, finish_reason: 'tool_calls' }] };
const payload = (search = false) => ({
    systemPrompt: 'synthetic', userPrompt: 'synthetic', apiConfig: { apiKey: 'synthetic-key', baseUrl: 'https://provider.example.test/v1', model: 'synthetic' },
    ...(search ? { tools: { functionSearch: true, searchConfig: { provider: 'tavily', apiKey: 'test-search-key' } } } : {}),
});
const req = (body, signal) => new Request('https://author.example.test/api/ai', { method: 'POST', body: JSON.stringify(body), signal });

async function fixture(provider, fetchImpl, timeoutMs) {
    const routeUrl = new URL(provider === 'search' ? '../app/api/tools/search/route.js' : `../app/api/ai/${provider === 'openai' ? '' : provider + '/'}route.js`, import.meta.url);
    const id = ++instance;
    const lifecycleUrl = new URL('../app/lib/ai-request-lifecycle.js', import.meta.url).href;
    const mockUrl = `data:text/javascript,${encodeURIComponent(`
        import { createGenerationLifecycle as create, generationAbortResponse } from '${lifecycleUrl}';
        export { generationAbortResponse };
        export const createGenerationLifecycle = signal => create(signal, ${timeoutMs ?? 2000});
        let fetcher; export const configure = value => { fetcher = value; };
        export const proxyFetch = (...args) => fetcher(...args);
        export const rotateKey = key => key;
        export const applyContentSafety = text => text;
        export const isOutboundRequestBlocked = () => false;
        export const isServerCredentialBlocked = () => false;
        export const resolveAiCredential = ({clientApiKey, clientBaseUrl}) => ({apiKey: clientApiKey, baseUrl: clientBaseUrl});
        export const safeUpstreamDetail = () => 'Synthetic upstream failure';
        // fixture ${id}
    `)}`;
    (await import(mockUrl)).configure(fetchImpl);
    const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
        if (context.parentURL?.startsWith(routeUrl.href) && /\/(proxy-fetch|keyRotator|content-safety|server-security\.mjs|ai-request-lifecycle\.js)$/.test(specifier)) {
            return { url: mockUrl, shortCircuit: true };
        }
        return nextResolve(specifier, context);
    } });
    try { return await import(`${routeUrl.href}?fixture=${id}`); }
    finally { hooks.deregister(); }
}

async function waitFor(condition) {
    for (let i = 0; i < 100 && !condition(); i++) await delay(5);
    assert.ok(condition(), 'condition was not reached');
}

for (const provider of ['openai', 'claude', 'gemini', 'search']) {
    test(`${provider}: cancellation before headers aborts transport and returns cancelled`, async () => {
        const controller = new AbortController();
        let signal;
        const api = await fixture(provider, (_url, options) => {
            signal = options.signal;
            return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
        });
        const body = provider === 'search' ? { query: 'synthetic', searchConfig: { provider: 'exa', apiKey: 'synthetic' } } : payload();
        const result = api.POST(req(body, controller.signal));
        await waitFor(() => signal);
        controller.abort();
        assert.equal(signal.aborted, true, 'request cancellation did not reach the transport');
        const response = await result;
        assert.equal(signal.aborted, true);
        assert.equal(response.status, 499);
        assert.equal((await response.json()).status, 'cancelled');
    });
}

for (const provider of ['openai', 'claude']) {
    test(`${provider}: aborting search prevents remaining searches and round two`, async () => {
        const controller = new AbortController();
        const calls = [];
        const api = await fixture(provider, async (url, options) => {
            calls.push({ url, signal: options.signal });
            if (calls.length === 1) return Response.json(toolReply(provider));
            return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
        });
        const result = api.POST(req(payload(true), controller.signal));
        await waitFor(() => calls.length === 2);
        controller.abort();
        assert.equal((await result).status, 499);
        assert.equal(calls.length, 2);
        assert.equal(calls[0].signal, calls[1].signal);
        assert.equal(calls[1].signal.aborted, true);
    });

    test(`${provider}: search and round-two stream share the request lifecycle`, async () => {
        const calls = [];
        let cancelled = false;
        const api = await fixture(provider, async (url, options) => {
            calls.push({ url, signal: options.signal });
            if (calls.length === 1) return Response.json(toolReply(provider));
            if (url.endsWith('/search')) return Response.json({ results: [{ title: 'Synthetic source', url: 'https://example.test', content: 'synthetic' }] });
            return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
        });
        const response = await api.POST(req(payload(true)));
        assert.equal(calls.length, 4);
        assert.ok(calls.every(c => c.signal === calls[0].signal));
        await response.body.cancel();
        assert.equal(calls[0].signal.aborted, true);
        assert.equal(cancelled, true);
    });

    test(`${provider}: missing or token-limited non-stream results never report success`, async () => {
        for (const data of [{}, provider === 'openai'
            ? { choices: [{ message: { content: 'partial' }, finish_reason: 'length' }] }
            : { content: [{ type: 'text', text: 'partial' }], stop_reason: 'max_tokens' }]) {
            const api = await fixture(provider, async () => Response.json(data));
            const response = await api.POST(req(payload(true)));
            await assert.rejects(async () => { for await (const event of readAiEvents(response)) void event; }, { code: 'AI_STREAM_INCOMPLETE' });
        }
    });
}

test('request timeout before response headers is reported as incomplete', async () => {
    const api = await fixture('openai', (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })), 10);
    const response = await api.POST(req(payload()));
    assert.equal(response.status, 504);
    assert.equal((await response.json()).code, 'AI_GENERATION_TIMEOUT');
});

test('pre-aborted requests never start an upstream request', async () => {
    const controller = new AbortController(); controller.abort();
    let calls = 0;
    const api = await fixture('openai', async () => { calls++; });
    assert.equal((await api.POST(req(payload(), controller.signal))).status, 499);
    assert.equal(calls, 0);
});

// Real sockets, synthetic local upstream: verifies fetch abort closes the
// connection during both JSON round one and an active SSE response.
for (const streaming of [false, true]) test(`real HTTP upstream closes on ${streaming ? 'downstream cancellation' : 'non-stream request abort'}`, async t => {
    let connected = false, closed = false;
    const server = http.createServer((_request, response) => {
        connected = true;
        response.on('close', () => { closed = true; });
        response.writeHead(200, { 'content-type': streaming ? 'text/event-stream' : 'application/json' });
        response.write(streaming ? sse(openText('partial')) : '{"choices":[');
    });
    await listenLocal(server);
    t.after(() => { server.closeAllConnections(); server.close(); });
    const address = `http://127.0.0.1:${server.address().port}`;
    const api = await fixture('openai', (_url, options) => fetch(address, options));
    const controller = new AbortController();
    const result = api.POST(req(payload(!streaming), controller.signal));
    await waitFor(() => connected);
    if (streaming) {
        const reader = (await result).body.getReader();
        assert.match(new TextDecoder().decode((await reader.read()).value), /partial/);
        await reader.cancel();
    } else {
        controller.abort();
        assert.equal((await result).status, 499);
    }
    await waitFor(() => closed);
});
