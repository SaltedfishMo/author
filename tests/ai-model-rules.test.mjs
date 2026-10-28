import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildClaudeRequestParams,
    buildGeminiThinkingConfig,
    buildOpenAiCompatibleParams,
    getClaudeModelRules,
    isDeepSeekRequest,
    isDeepSeekThinkingMode,
    isDeepSeekThinkingModel,
    normalizeOpenAiReasoningEffort,
    parseClaudeModel,
    usesGeminiThinkingLevel,
    usesMaxCompletionTokens,
} from '../app/lib/ai-model-rules.js';

const EFFORTS = ['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max'];

// ==================== DeepSeek ====================

test('DeepSeek：deepseek-flash 与 V4 系列都识别为支持思考开关的模型', () => {
    for (const model of ['deepseek-flash', ' DeepSeek-Flash ', 'deepseek-v4-pro', 'deepseek-v4-flash']) {
        assert.equal(isDeepSeekThinkingModel(model), true, model);
    }
    for (const model of ['deepseek-chat', 'deepseek-ai/DeepSeek-V3', 'gpt-6-astra', '']) {
        assert.equal(isDeepSeekThinkingModel(model), false, model);
    }
    assert.equal(isDeepSeekRequest({}, 'https://relay.example.test/v1', 'deepseek-flash'), true);
    assert.equal(isDeepSeekRequest({ providerType: 'deepseek' }, '', 'anything'), true);
});

test('DeepSeek：deepseek-flash 关闭思考时发 disabled，温度照常生效，不发 reasoning_effort', () => {
    const params = buildOpenAiCompatibleParams({ model: 'deepseek-flash', temperature: 0.7, topP: 0.9, reasoningEffort: 'none' });
    assert.deepEqual(params, { temperature: 0.7, top_p: 0.9, thinking: { type: 'disabled' } });
});

test('DeepSeek：思考开启时不发温度和 top_p，思考强度 low / high / max 原样传', () => {
    for (const effort of ['low', 'high', 'max']) {
        const params = buildOpenAiCompatibleParams({ model: 'deepseek-flash', temperature: 0.7, topP: 0.9, maxTokens: 4096, reasoningEffort: effort });
        assert.deepEqual(params, { max_tokens: 4096, thinking: { type: 'enabled' }, reasoning_effort: effort });
    }
    const auto = buildOpenAiCompatibleParams({ model: 'deepseek-flash', reasoningEffort: 'auto' });
    assert.deepEqual(auto, { thinking: { type: 'enabled' } });
});

test('DeepSeek：思考模式下工具调用回合保留 reasoning_content', () => {
    const cfg = { providerType: 'deepseek' };
    assert.equal(isDeepSeekThinkingMode(cfg, 'https://api.deepseek.com', 'deepseek-flash', 'high'), true);
    assert.equal(isDeepSeekThinkingMode(cfg, 'https://api.deepseek.com', 'deepseek-flash', undefined), true);
    assert.equal(isDeepSeekThinkingMode(cfg, 'https://api.deepseek.com', 'deepseek-flash', 'none'), false);
    assert.equal(isDeepSeekThinkingMode({}, 'https://relay.example.test/v1', 'gpt-6-astra', 'high'), false);
});

// ==================== Gemini ====================

test('Gemini：3.x / 4 用 thinkingLevel，2.5 用 thinkingBudget，两者不会同时出现', () => {
    for (const model of ['gemini-4-argon', 'gemini-3.8-flash', 'models/gemini-3.6-flash', 'gemini-3.1-flash-lite', 'gemini-flash-latest']) {
        assert.equal(usesGeminiThinkingLevel(model), true, model);
    }
    for (const model of ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemma-3-27b-it']) {
        assert.equal(usesGeminiThinkingLevel(model), false, model);
    }
    for (const model of ['gemini-4-argon', 'gemini-3.8-flash', 'gemini-2.5-flash', 'gemini-2.5-pro']) {
        for (const effort of EFFORTS) {
            const config = buildGeminiThinkingConfig(model, effort);
            if (config) assert.equal(Object.keys(config).length, 1, `${model}/${effort}`);
        }
    }
});

test('Gemini：auto 或未设置时不覆盖模型默认思考', () => {
    assert.equal(buildGeminiThinkingConfig('gemini-3.8-flash', 'auto'), null);
    assert.equal(buildGeminiThinkingConfig('gemini-3.8-flash', undefined), null);
});

test('Gemini：关闭思考降到该模型支持的最低档，不发不支持的 minimal', () => {
    assert.deepEqual(buildGeminiThinkingConfig('gemini-4-argon', 'none'), { thinkingLevel: 'low' });
    assert.deepEqual(buildGeminiThinkingConfig('gemini-3.8-flash', 'none'), { thinkingLevel: 'low' });
    assert.deepEqual(buildGeminiThinkingConfig('gemini-3.6-flash', 'none'), { thinkingLevel: 'minimal' });
    assert.deepEqual(buildGeminiThinkingConfig('gemini-3.5-flash-lite', 'none'), { thinkingLevel: 'minimal' });
    assert.deepEqual(buildGeminiThinkingConfig('gemini-4-argon', 'max'), { thinkingLevel: 'high' });
    assert.deepEqual(buildGeminiThinkingConfig('gemini-3.8-flash', 'medium'), { thinkingLevel: 'medium' });
});

test('Gemini 2.5：thinkingBudget 不超出各型号允许范围', () => {
    assert.deepEqual(buildGeminiThinkingConfig('gemini-2.5-flash', 'none'), { thinkingBudget: 0 });
    assert.deepEqual(buildGeminiThinkingConfig('gemini-2.5-flash', 'high'), { thinkingBudget: 24576 });
    assert.deepEqual(buildGeminiThinkingConfig('gemini-2.5-flash-lite', 'max'), { thinkingBudget: 24576 });
    assert.deepEqual(buildGeminiThinkingConfig('gemini-2.5-pro', 'none'), { thinkingBudget: 128 });
    assert.deepEqual(buildGeminiThinkingConfig('gemini-2.5-pro', 'high'), { thinkingBudget: 32768 });
});

test('Gemini OpenAI 兼容层：reasoning_effort 换成它认识的取值', () => {
    assert.equal(normalizeOpenAiReasoningEffort('gemini-3.8-flash', 'none'), 'low');
    assert.equal(normalizeOpenAiReasoningEffort('gemini-3.5-flash-lite', 'none'), 'minimal');
    assert.equal(normalizeOpenAiReasoningEffort('gemini-2.5-flash', 'none'), 'none');
    assert.equal(normalizeOpenAiReasoningEffort('gemini-4-argon', 'xhigh'), 'high');
    assert.equal(normalizeOpenAiReasoningEffort('gpt-6-astra', 'xhigh'), 'xhigh');
    assert.equal(normalizeOpenAiReasoningEffort('gpt-6-astra', 'auto'), null);
});

// ==================== OpenAI ====================

test('OpenAI 推理系列用 max_completion_tokens，其他模型仍用 max_tokens', () => {
    for (const model of ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-5.6-sol', 'gpt-5', 'o3', 'o4-mini']) {
        assert.equal(usesMaxCompletionTokens(model), true, model);
    }
    for (const model of ['gpt-4o', 'gpt-4.1-mini', 'gpt-oss-120b', 'glm-5', 'openai/gpt-6-astra', 'deepseek-flash']) {
        assert.equal(usesMaxCompletionTokens(model), false, model);
    }
    assert.deepEqual(buildOpenAiCompatibleParams({ model: 'gpt-6-astra', maxTokens: 2048, reasoningEffort: 'max' }), { max_completion_tokens: 2048, reasoning_effort: 'max' });
    assert.deepEqual(buildOpenAiCompatibleParams({ model: 'glm-5', maxTokens: 2048, temperature: 0.8 }), { temperature: 0.8, max_tokens: 2048 });
});

// ==================== Claude ====================

test('Claude：模型名解析覆盖新旧命名和常见前缀', () => {
    assert.deepEqual(parseClaudeModel('claude-opus-5-5'), { family: 'opus', version: 5.5 });
    assert.deepEqual(parseClaudeModel('claude-opus-5'), { family: 'opus', version: 5 });
    assert.deepEqual(parseClaudeModel('claude-sonnet-4-20250514'), { family: 'sonnet', version: 4 });
    assert.deepEqual(parseClaudeModel('claude-haiku-4-5-20251001'), { family: 'haiku', version: 4.5 });
    assert.deepEqual(parseClaudeModel('claude-3-7-sonnet-20250219'), { family: 'sonnet', version: 3.7 });
    assert.deepEqual(parseClaudeModel('anthropic/claude-opus-4.6'), { family: 'opus', version: 4.6 });
    assert.deepEqual(parseClaudeModel('us.anthropic.claude-opus-4-6-v1'), { family: 'opus', version: 4.6 });
    assert.deepEqual(parseClaudeModel('claude-fable-5-1'), { family: 'fable', version: 5.1 });
    assert.equal(parseClaudeModel('MiniMax-M2.5'), null);
});

const NEW_GENERATION = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-4-7'];

test('Claude 新一代模型：任何思考档位都不发 budget_tokens，也不发 temperature / top_p', () => {
    for (const model of NEW_GENERATION) {
        for (const effort of EFFORTS) {
            const params = buildClaudeRequestParams({ model, temperature: 0.7, topP: 0.9, reasoningEffort: effort });
            assert.equal(params.thinking?.type === 'enabled', false, `${model}/${effort}`);
            assert.equal('budget_tokens' in (params.thinking || {}), false, `${model}/${effort}`);
            assert.equal('temperature' in params, false, `${model}/${effort}`);
            assert.equal('top_p' in params, false, `${model}/${effort}`);
        }
    }
});

test('Claude 新一代模型：开启思考用 adaptive + output_config.effort，并要求返回思考摘要', () => {
    assert.deepEqual(buildClaudeRequestParams({ model: 'claude-opus-5-5', reasoningEffort: 'high' }), {
        max_tokens: 32000,
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort: 'high' },
    });
    assert.deepEqual(buildClaudeRequestParams({ model: 'claude-sonnet-5-5', maxTokens: 65536, reasoningEffort: 'max' }), {
        max_tokens: 65536,
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort: 'max' },
    });
});

test('Claude：关闭思考按模型选写法，Opus 5.5 无法关闭时降到 low', () => {
    assert.deepEqual(buildClaudeRequestParams({ model: 'claude-opus-5-5', reasoningEffort: 'none' }), { max_tokens: 32000, output_config: { effort: 'low' } });
    assert.deepEqual(buildClaudeRequestParams({ model: 'claude-fable-5-1', reasoningEffort: 'none' }), { max_tokens: 32000, output_config: { effort: 'low' } });
    assert.deepEqual(buildClaudeRequestParams({ model: 'claude-sonnet-5-5', reasoningEffort: 'none' }), { max_tokens: 32000, thinking: { type: 'between_tools' } });
    assert.deepEqual(buildClaudeRequestParams({ model: 'claude-haiku-5-5', reasoningEffort: 'none' }), { max_tokens: 32000, thinking: { type: 'disabled' } });
    assert.deepEqual(buildClaudeRequestParams({ model: 'claude-opus-5', reasoningEffort: 'none' }), { max_tokens: 32000, thinking: { type: 'disabled' } });
    assert.deepEqual(buildClaudeRequestParams({ model: 'claude-opus-4-8', reasoningEffort: 'none' }), { max_tokens: 32000 });
    assert.deepEqual(buildClaudeRequestParams({ model: 'claude-opus-5-5', reasoningEffort: 'auto' }), { max_tokens: 32000 });
});

test('Claude 4.6：adaptive 思考，不支持的 xhigh 降一档；采样参数两者只发一个', () => {
    assert.deepEqual(buildClaudeRequestParams({ model: 'claude-sonnet-4-6', reasoningEffort: 'xhigh' }), {
        max_tokens: 32000, thinking: { type: 'adaptive' }, output_config: { effort: 'high' },
    });
    assert.deepEqual(buildClaudeRequestParams({ model: 'claude-opus-4-6', temperature: 0.7, topP: 0.9 }), { max_tokens: 32000, temperature: 0.7 });
    assert.deepEqual(buildClaudeRequestParams({ model: 'claude-opus-4-6', topP: 0.9 }), { max_tokens: 32000, top_p: 0.9 });
});

test('Claude 老模型（Haiku 4.5 及更早）继续用 budget_tokens，且预算小于 max_tokens', () => {
    assert.equal(getClaudeModelRules('claude-haiku-4-5').thinking, 'budget');
    assert.equal(getClaudeModelRules('claude-sonnet-4-20250514').thinking, 'budget');
    assert.deepEqual(buildClaudeRequestParams({ model: 'claude-haiku-4-5', temperature: 0.7, topP: 0.9, reasoningEffort: 'high' }), {
        max_tokens: 32000, thinking: { type: 'enabled', budget_tokens: 16000 },
    });
    assert.deepEqual(buildClaudeRequestParams({ model: 'claude-haiku-4-5', topP: 0.95, maxTokens: 65536, reasoningEffort: 'medium' }), {
        max_tokens: 65536, thinking: { type: 'enabled', budget_tokens: 8192 }, top_p: 0.95,
    });
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
        for (const maxTokens of [undefined, 4096, 8192, 65536]) {
            const params = buildClaudeRequestParams({ model: 'claude-sonnet-4-5', maxTokens, reasoningEffort: effort });
            assert.ok(params.thinking.budget_tokens < params.max_tokens, `${effort}/${maxTokens}`);
            assert.ok(params.thinking.budget_tokens >= 1024, `${effort}/${maxTokens}`);
        }
    }
    // max_tokens 太小、放不下最低 1024 的思考预算时不开思考
    assert.deepEqual(buildClaudeRequestParams({ model: 'claude-haiku-4-5', maxTokens: 1500, reasoningEffort: 'high' }), { max_tokens: 1500 });
});

test('Claude 兼容端点上的非 Claude 模型保持原有写法（budget_tokens、两个采样参数都发）', () => {
    assert.deepEqual(buildClaudeRequestParams({ model: 'MiniMax-M2.5', temperature: 0.7, topP: 0.9 }), { max_tokens: 8192, temperature: 0.7, top_p: 0.9 });
    assert.deepEqual(buildClaudeRequestParams({ model: 'qwen3.7-plus', topP: 0.95, reasoningEffort: 'medium' }), {
        max_tokens: 8192, thinking: { type: 'enabled', budget_tokens: 4096 }, top_p: 0.95,
    });
});

// ==================== MiniMax ====================

test('MiniMax M3.1-Flash（OpenAI 格式）：思考档位照传，none 降到 low，不发会被拒绝的关闭思考', () => {
    assert.deepEqual(buildOpenAiCompatibleParams({ model: 'MiniMax-M3.1-Flash', reasoningEffort: 'none' }), { reasoning_effort: 'low' });
    assert.deepEqual(buildOpenAiCompatibleParams({ model: 'minimax/minimax-m3.1-flash-preview', reasoningEffort: 'max' }), { reasoning_effort: 'max' });
    assert.deepEqual(buildOpenAiCompatibleParams({ model: 'MiniMax-M3.1-Flash', reasoningEffort: 'auto' }), {});
    for (const effort of EFFORTS) {
        const params = buildOpenAiCompatibleParams({ model: 'MiniMax-M3.1-Flash', reasoningEffort: effort });
        assert.notEqual(params.reasoning_effort, 'none', effort);
        assert.equal('thinking' in params, false, effort);
    }
});

test('MiniMax-M3（OpenAI 格式）：不发 reasoning_effort，关闭思考发 thinking.disabled；M2.x 保持原有写法', () => {
    assert.deepEqual(buildOpenAiCompatibleParams({ model: 'MiniMax-M3', reasoningEffort: 'none' }), { thinking: { type: 'disabled' } });
    assert.deepEqual(buildOpenAiCompatibleParams({ model: 'minimax-m3', reasoningEffort: 'high' }), {});
    assert.deepEqual(buildOpenAiCompatibleParams({ model: 'MiniMax-M2.7', reasoningEffort: 'high' }), { reasoning_effort: 'high' });
});

test('MiniMax M3 系列（Anthropic 格式）：默认给足输出额度，档位用 output_config.effort，不发 budget_tokens', () => {
    // 思考计入 max_tokens，8192 不够长篇任务想完再写正文；采样参数 MiniMax 不生效，不再发送
    assert.deepEqual(buildClaudeRequestParams({ model: 'MiniMax-M3.1-Flash', temperature: 0.7, topP: 0.9 }), { max_tokens: 65536 });
    assert.deepEqual(buildClaudeRequestParams({ model: 'MiniMax-M3.1-Flash', reasoningEffort: 'medium' }), {
        max_tokens: 65536, thinking: { type: 'adaptive' }, output_config: { effort: 'medium' },
    });
    assert.deepEqual(buildClaudeRequestParams({ model: 'MiniMax-M3.1-Flash', reasoningEffort: 'none' }), { max_tokens: 65536, output_config: { effort: 'low' } });
    assert.deepEqual(buildClaudeRequestParams({ model: 'MiniMax-M3', reasoningEffort: 'high' }), { max_tokens: 65536, thinking: { type: 'adaptive' } });
    assert.deepEqual(buildClaudeRequestParams({ model: 'MiniMax-M3', reasoningEffort: 'none' }), { max_tokens: 65536, thinking: { type: 'disabled' } });
    assert.deepEqual(buildClaudeRequestParams({ model: 'MiniMax-M3', maxTokens: 4096 }), { max_tokens: 4096 });
    for (const model of ['MiniMax-M3.1-Flash', 'MiniMax-M3']) {
        for (const effort of EFFORTS) {
            const params = buildClaudeRequestParams({ model, reasoningEffort: effort });
            assert.equal('budget_tokens' in (params.thinking || {}), false, `${model}/${effort}`);
            assert.ok(!params.output_config || params.output_config.effort, `${model}/${effort}`);
        }
    }
    for (const effort of EFFORTS) {
        assert.notEqual(buildClaudeRequestParams({ model: 'MiniMax-M3.1-Flash', reasoningEffort: effort }).thinking?.type, 'disabled', effort);
    }
});
