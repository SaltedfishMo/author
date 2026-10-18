import assert from 'node:assert/strict';
import test from 'node:test';

import {
    migrateApiConfigToCompatible,
    resolveAiEndpoint,
} from '../app/lib/ai-provider-compat.js';
import { getBuiltInEndpointName } from '../app/lib/built-in-labels.js';

test('DeepSeek preset overrides a stale Claude providerType', () => {
    assert.equal(resolveAiEndpoint({
        provider: 'deepseek',
        providerType: 'claude',
        apiFormat: 'anthropic',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-v4-pro',
    }), '/api/ai');
});

test('DeepSeek instance key also overrides stale protocol metadata', () => {
    assert.equal(resolveAiEndpoint({
        provider: 'deepseek_k3x9',
        providerType: 'claude',
        apiFormat: 'anthropic',
    }), '/api/ai');
});

test('real Claude and explicit Anthropic-compatible configurations keep the Claude route', () => {
    assert.equal(resolveAiEndpoint({ provider: 'claude', providerType: 'claude' }), '/api/ai/claude');
    assert.equal(resolveAiEndpoint({ provider: 'custom', apiFormat: 'anthropic' }), '/api/ai/claude');
});

test('Gemini native configuration keeps its dedicated route', () => {
    assert.equal(resolveAiEndpoint({ provider: 'gemini-native' }), '/api/ai/gemini');
});

test('migration repairs stale DeepSeek protocol metadata at both levels', () => {
    const config = {
        provider: 'deepseek',
        providerType: 'claude',
        apiFormat: 'anthropic',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-v4-pro',
        providerConfigs: {
            deepseek: {
                providerType: 'claude',
                apiFormat: 'anthropic',
                baseUrl: 'https://api.deepseek.com',
                model: 'deepseek-v4-pro',
                models: ['deepseek-v4-pro'],
            },
        },
    };

    assert.equal(migrateApiConfigToCompatible(config), true);
    assert.equal(config.providerType, 'deepseek');
    assert.equal('apiFormat' in config, false);
    assert.equal(config.providerConfigs.deepseek.providerType, 'deepseek');
    assert.equal('apiFormat' in config.providerConfigs.deepseek, false);
    assert.equal(resolveAiEndpoint(config), '/api/ai');
});

test('retired providers become custom endpoints without losing the saved key, URL or models', () => {
    const config = {
        provider: 'yi',
        providerType: 'yi',
        apiKey: 'synthetic-key',
        baseUrl: 'https://yi.example.test/v1',
        model: 'yi-lightning',
        providerConfigs: {
            yi: { apiKey: 'synthetic-key', baseUrl: 'https://yi.example.test/v1', model: 'yi-lightning', models: ['yi-lightning'] },
            github_k3x9: { providerType: 'github', instanceName: 'my relay', apiKey: 'synthetic-key-2', baseUrl: 'https://relay.example.test/v1' },
            custom: { apiKey: 'synthetic-key-3', baseUrl: 'http://127.0.0.1:11434/v1', model: 'fixture-model' },
        },
    };

    assert.equal(migrateApiConfigToCompatible(config), true);
    assert.equal(config.provider, 'yi');
    assert.equal(config.providerType, 'custom');
    assert.equal(resolveAiEndpoint(config), '/api/ai');

    const yi = config.providerConfigs.yi;
    assert.equal(yi.providerType, 'custom');
    assert.equal(yi.instanceName, '零一万物（已停服）');
    assert.equal(yi.apiKey, 'synthetic-key');
    assert.equal(yi.baseUrl, 'https://yi.example.test/v1');
    assert.deepEqual(yi.models, ['yi-lightning']);

    // 用户自己起的实例名保留；已有的自定义端点不被覆盖
    assert.equal(config.providerConfigs.github_k3x9.providerType, 'custom');
    assert.equal(config.providerConfigs.github_k3x9.instanceName, 'my relay');
    assert.equal(config.providerConfigs.custom.baseUrl, 'http://127.0.0.1:11434/v1');

    // 再次加载不会重复迁移
    assert.equal(migrateApiConfigToCompatible(config), false);

    const text = (zh, en) => en;
    assert.equal(getBuiltInEndpointName(yi.instanceName, text), '01.AI Yi (discontinued)');
});

test('a retired provider selected without a saved entry switches to the custom endpoint', () => {
    const config = { provider: 'github', apiKey: 'synthetic-key', baseUrl: 'https://relay.example.test/v1', model: 'fixture-model' };
    assert.equal(migrateApiConfigToCompatible(config), true);
    assert.equal(config.provider, 'custom');
    assert.equal(config.providerType, 'custom');
    assert.equal(config.baseUrl, 'https://relay.example.test/v1');
});
