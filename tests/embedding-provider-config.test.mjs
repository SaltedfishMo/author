import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

import { getEmbeddingProviderConfig, switchEmbeddingModel } from '../app/lib/embedding-provider-config.js';

function localConfig() {
    return {
        useCustomEmbed: true,
        provider: 'openai',
        apiKey: 'test-chat',
        baseUrl: 'https://chat.example.test/v1',
        embedProvider: 'custom',
        embedModel: 'embedding-old',
        embedBaseUrl: 'http://localhost:11434/v1',
        embedApiKey: '',
        embedReuseChatKey: false,
        embedProviderConfigs: {
            custom: {
                apiKey: 'test-stale',
                baseUrl: 'https://old.example.test/v1',
                model: 'old-saved-model',
                models: ['embedding-old', 'embedding-new'],
            },
        },
    };
}

test('local models are selectable with no key while reuse is disabled', () => {
    const state = getEmbeddingProviderConfig(localConfig());
    assert.equal(state.apiKey, '');
    assert.equal(state.effectiveApiKey, '');
    assert.equal(state.allowKeyless, true);
    assert.equal(state.isConfigured, true);
});

test('changing a model preserves live address and explicit empty key over stale saved values', () => {
    const original = localConfig();
    const snapshot = structuredClone(original);
    const changed = switchEmbeddingModel(original, 'custom', 'embedding-new');
    assert.deepEqual(original, snapshot);
    assert.equal(changed.embedBaseUrl, original.embedBaseUrl);
    assert.equal(changed.embedApiKey, '');
    assert.equal(changed.embedReuseChatKey, false);
    assert.equal(changed.embedModel, 'embedding-new');
    assert.equal(changed.embedProviderConfigs.custom.baseUrl, original.embedBaseUrl);
    assert.equal(changed.embedProviderConfigs.custom.apiKey, '');
    assert.equal(changed.embedProviderConfigs.custom.model, 'embedding-new');
    assert.deepEqual(changed.embedProviderConfigs.custom.models, original.embedProviderConfigs.custom.models);
    assert.equal(changed.apiKey, original.apiKey);
    assert.equal(changed.baseUrl, original.baseUrl);
});

test('switching away and back preserves the local provider configuration', () => {
    const original = localConfig();
    original.embedProviderConfigs.remote = {
        providerType: 'custom',
        apiKey: 'test-embed',
        baseUrl: 'https://embed.example.test/v1',
        models: ['remote-embedding'],
    };
    const remote = switchEmbeddingModel(original, 'remote', 'remote-embedding');
    assert.equal(remote.embedApiKey, 'test-embed');
    assert.equal(remote.embedBaseUrl, 'https://embed.example.test/v1');
    const returned = switchEmbeddingModel(remote, 'custom', 'embedding-new');
    assert.equal(returned.embedBaseUrl, original.embedBaseUrl);
    assert.equal(returned.embedApiKey, '');
    assert.equal(returned.embedReuseChatKey, false);
});

test('cleared addresses stay empty instead of restoring a saved or default address', () => {
    const config = { ...localConfig(), embedBaseUrl: '' };
    const defaults = { baseUrl: 'https://default.example.test/v1' };
    assert.equal(getEmbeddingProviderConfig(config, 'custom', defaults).isConfigured, false);
    assert.equal(switchEmbeddingModel(config, 'custom', 'embedding-new', defaults).embedBaseUrl, '');
});

test('legacy reuse and explicitly provided embedding keys keep their request precedence', () => {
    const config = { ...localConfig(), embedReuseChatKey: undefined };
    const legacy = getEmbeddingProviderConfig(config);
    assert.equal(legacy.effectiveApiKey, 'test-chat');
    assert.equal(legacy.allowKeyless, false);
    assert.equal(getEmbeddingProviderConfig({ ...config, embedApiKey: 'test-embed' }).effectiveApiKey, 'test-embed');
    const selected = switchEmbeddingModel(config, 'custom', 'embedding-new');
    assert.equal(selected.embedApiKey, '', 'An inherited chat key must not become a saved embedding key.');
});

test('saved custom instances allow keyless selection and disabled embedding stays disabled', () => {
    const config = localConfig();
    config.embedProviderConfigs.local_second = { providerType: 'custom', baseUrl: 'http://localhost:11435/v1', apiKey: '', models: ['embed-second'] };
    assert.equal(getEmbeddingProviderConfig(config, 'local_second').isConfigured, true);
    assert.equal(getEmbeddingProviderConfig({ ...config, useCustomEmbed: false }, 'local_second').isConfigured, false);
    assert.equal(getEmbeddingProviderConfig({ ...config, embedReuseChatKey: true, apiKey: '' }, 'local_second').isConfigured, false);
});

test('new provider defaults fill missing addresses without copying the chat key', () => {
    const config = { ...localConfig(), embedReuseChatKey: true };
    const changed = switchEmbeddingModel(config, 'new-provider', 'new-model', { baseUrl: 'https://new.example.test/v1' });
    assert.equal(changed.embedBaseUrl, 'https://new.example.test/v1');
    assert.equal(changed.embedApiKey, '');
    assert.equal(changed.embedProviderConfigs['new-provider'].apiKey, '');
    assert.equal(getEmbeddingProviderConfig(changed).effectiveApiKey, 'test-chat');
});

test('unused providers do not appear configured just because key reuse or keyless access is enabled', () => {
    for (const embedReuseChatKey of [true, false]) {
        const config = { ...localConfig(), embedReuseChatKey };
        assert.equal(getEmbeddingProviderConfig(config, 'unused-provider', { baseUrl: 'https://unused.example.test/v1' }).isConfigured, false);
    }
});

test('embedding requests after model switching honor the selected address and key policy', async t => {
    const routeUrl = new URL('../app/api/embed/route.js', import.meta.url).href;
    const calls = [];
    const stubSymbol = Symbol.for('author.embedding-config-test.proxyFetch');
    globalThis[stubSymbol] = async (url, options) => {
        calls.push({ url, options });
        return Response.json({ data: [{ embedding: [0.25, 0.75] }] });
    };
    const stubUrl = `data:text/javascript,${encodeURIComponent("export const proxyFetch = (...args) => globalThis[Symbol.for('author.embedding-config-test.proxyFetch')](...args);")}`;
    const hooks = registerHooks({
        resolve(specifier, context, nextResolve) {
            if (context.parentURL === routeUrl) {
                if (specifier === '../../lib/proxy-fetch') return { url: stubUrl, shortCircuit: true };
                if (specifier === '../../lib/keyRotator') return nextResolve(`${specifier}.js`, context);
            }
            return nextResolve(specifier, context);
        },
    });
    t.after(() => { hooks.deregister(); delete globalThis[stubSymbol]; });
    const { POST } = await import(routeUrl);
    async function send(apiConfig) {
        calls.length = 0;
        return POST(new Request('https://author.example.test/api/embed', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: 'Synthetic test passage', apiConfig }),
        }));
    }

    await t.test('keyless local request has no Authorization header', async () => {
        const changed = switchEmbeddingModel(localConfig(), 'custom', 'embedding-new');
        const response = await send(changed);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { embedding: [0.25, 0.75] });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, 'http://localhost:11434/v1/embeddings');
        assert.equal(new Headers(calls[0].options.headers).has('Authorization'), false);
        assert.equal(JSON.parse(calls[0].options.body).model, 'embedding-new');
    });
    await t.test('legacy reuse still sends the chat key when requested', async () => {
        const config = { ...localConfig(), embedReuseChatKey: undefined };
        const response = await send(switchEmbeddingModel(config, 'custom', 'embedding-new'));
        assert.equal(response.status, 200);
        assert.equal(new Headers(calls[0].options.headers).get('Authorization'), 'Bearer test-chat');
    });
    await t.test('an explicit embedding key takes precedence', async () => {
        const config = { ...localConfig(), embedApiKey: 'test-embed' };
        const response = await send(switchEmbeddingModel(config, 'custom', 'embedding-new'));
        assert.equal(response.status, 200);
        assert.equal(new Headers(calls[0].options.headers).get('Authorization'), 'Bearer test-embed');
    });
    await t.test('missing address prevents upstream requests', async () => {
        const config = { ...localConfig(), embedBaseUrl: '' };
        const response = await send(switchEmbeddingModel(config, 'custom', 'embedding-new'));
        assert.equal(response.status, 400);
        assert.equal((await response.json()).code, 'NO_BASE_URL_EMBED');
        assert.equal(calls.length, 0);
    });
});
