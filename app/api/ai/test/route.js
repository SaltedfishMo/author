import { withApiResources } from '../../../lib/api-resource-guard.js';
import { NextResponse } from 'next/server';
import { proxyFetch } from '../../../lib/proxy-fetch';
import { rotateKey } from '../../../lib/keyRotator';
import { isOutboundRequestBlocked, safeUpstreamDetail } from '../../../lib/server-security.mjs';
import { buildClaudeRequestParams, DEEPSEEK_DEFAULT_MODEL, isDeepSeekRequest, usesMaxCompletionTokens } from '../../../lib/ai-model-rules.js';
import { isInsufficientBalanceError } from '../../../lib/ai-upstream-errors.js';

const OPENAI_DEFAULT_TEST_MODEL = 'gpt-6-luna';
const CLAUDE_DEFAULT_TEST_MODEL = 'claude-opus-5-5';

async function handlePOST(request) {
    try {
        const { apiConfig } = await request.json();
        let { apiKey, baseUrl, model, provider, providerType, apiFormat, proxyUrl } = apiConfig || {};
        apiKey = rotateKey(apiKey);
        // 调用方传入的 provider 已解析为实际供应商类型，应优先于可能由旧版
        // 浏览器配置残留的 providerType（例如 provider=deepseek/providerType=claude）。
        provider = provider || providerType;

        if (!apiKey) {
            return NextResponse.json({ success: false, error: '请先填入 API Key', code: 'NO_API_KEY' }, { status: 400 });
        }
        if (!baseUrl) {
            return NextResponse.json({ success: false, error: '请先填写兼容 API 地址', code: 'NO_BASE_URL_COMPAT' }, { status: 400 });
        }
        // DeepSeek 预设只暴露 OpenAI 兼容格式；旧版浏览器配置可能残留
        // apiFormat="anthropic"，不能因此把默认地址误拼成 /v1/messages。
        const useAnthropicFormat = provider === 'claude'
            || (apiFormat === 'anthropic' && provider !== 'deepseek');
        if (useAnthropicFormat) {
            return await testClaudeCompatible(apiKey, baseUrl, model, proxyUrl);
        }
        return await testOpenAICompatible(apiKey, baseUrl, model, proxyUrl, provider);
    } catch (error) {
        console.warn('API 测试连接失败:', error?.code || error?.name || 'UNKNOWN');
        if (isOutboundRequestBlocked(error)) {
            return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: 400 });
        }
        return NextResponse.json({ success: false, error: '网络连接失败，请检查兼容 API 地址或代理设置', code: 'NETWORK_ERROR_PROXY' });
    }
}

async function testOpenAICompatible(apiKey, baseUrl, model, proxyUrl, provider) {
    const isDeepSeek = isDeepSeekRequest({ provider }, baseUrl, model);
    const base = String(baseUrl || '').replace(/\/+$/, '');
    const selectedModel = model || (isDeepSeek ? DEEPSEEK_DEFAULT_MODEL : OPENAI_DEFAULT_TEST_MODEL);

    const response = await proxyFetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model: selectedModel,
            messages: [{ role: 'user', content: '说"连接成功"' }],
            [usesMaxCompletionTokens(selectedModel) ? 'max_completion_tokens' : 'max_tokens']: 20,
        }),
    }, proxyUrl);

    if (!response.ok) return connectionError(response);
    const data = await response.json();
    return NextResponse.json({
        success: true,
        message: '✅ OpenAI 兼容接口连接成功！',
        model: selectedModel,
        reply: String(data.choices?.[0]?.message?.content || '').trim(),
    });
}

async function testClaudeCompatible(apiKey, baseUrl, model, proxyUrl) {
    const base = String(baseUrl || '').replace(/\/+$/, '');
    const selectedModel = model || CLAUDE_DEFAULT_TEST_MODEL;
    const endpoint = base.endsWith('/v1') ? base + '/messages' : base + '/v1/messages';
    const response = await proxyFetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
            model: selectedModel,
            // 尽量少思考：思考无法关闭的新模型会降到最低档
            ...buildClaudeRequestParams({ model: selectedModel, maxTokens: 64, reasoningEffort: 'none' }),
            messages: [{ role: 'user', content: '说"连接成功"' }],
        }),
    }, proxyUrl);

    if (!response.ok) return connectionError(response);
    const data = await response.json();
    return NextResponse.json({
        success: true,
        message: '✅ Claude 兼容接口连接成功！',
        model: selectedModel,
        // 新模型的回复前面可能有 thinking 块，取第一个文本块
        reply: String((data.content || []).find(block => block?.type === 'text')?.text || '').trim(),
    });
}

async function connectionError(response) {
    const errorText = await response.text();
    if (isInsufficientBalanceError(errorText)) {
        return NextResponse.json({ success: false, error: 'API 账户余额不足，请充值后重试', code: 'AI_INSUFFICIENT_QUOTA' });
    }
    let upstream = null;
    try {
        upstream = safeUpstreamDetail(JSON.parse(errorText)?.error?.message || '', 300) || null;
    } catch { }
    // 上游原文（多为英文）保留、不加 code；仅在回退到自带中文文案时加 code 供前端本地化
    if (upstream) return NextResponse.json({ success: false, error: upstream });
    return NextResponse.json({ success: false, error: `连接失败(${response.status})`, code: 'CONN_FAILED', status: response.status });
}

export const POST = withApiResources('/api/ai/test', handlePOST);
