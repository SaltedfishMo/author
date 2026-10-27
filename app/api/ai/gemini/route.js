import { withApiResources } from '../../../lib/api-resource-guard.js';
import { createGenerationLifecycle, generationAbortResponse } from '../../../lib/ai-request-lifecycle.js';
import { streamAiResponse, createGeminiMapper } from '../../../lib/ai-stream.js';
// Gemini 原生 API — 按下游读取速度转发 SSE，并传递取消信号
// 使用 streamGenerateContent 端点

export const runtime = 'nodejs';
export const maxDuration = 120;

import { applyContentSafety } from '../../../lib/content-safety';
import { proxyFetch } from '../../../lib/proxy-fetch';
import { rotateKey } from '../../../lib/keyRotator';
import { isOutboundRequestBlocked, isServerCredentialBlocked, resolveAiCredential, safeUpstreamDetail } from '../../../lib/server-security.mjs';
import { buildGeminiThinkingConfig } from '../../../lib/ai-model-rules.js';
import { isInsufficientBalanceError } from '../../../lib/ai-upstream-errors.js';

async function handlePOST(request) {
    const lifecycle = createGenerationLifecycle(request.signal);
    const { signal } = lifecycle;
    try {
        signal.throwIfAborted();
        const { systemPrompt, userPrompt, apiConfig, maxTokens, temperature, topP, reasoningEffort, tools: toolsConfig } = await request.json();
        const proxyUrl = apiConfig?.proxyUrl || '';

        const credential = resolveAiCredential({
            request,
            clientApiKey: apiConfig?.apiKey,
            clientBaseUrl: apiConfig?.baseUrl,
            envApiKey: process.env.GEMINI_API_KEY,
            envBaseUrl: process.env.GEMINI_BASE_URL,
        });
        const apiKey = rotateKey(credential.apiKey);
        // 不内置官方默认地址：baseUrl 必须由用户填写（open core 边界）
        const baseUrl = credential.baseUrl;
        const model = apiConfig?.model || process.env.GEMINI_MODEL || 'gemini-3.8-flash';

        if (!apiKey) {
            return new Response(
                JSON.stringify({ error: '请先配置 Gemini 原生 API Key', code: 'NO_API_KEY_GEMINI' }),
                { status: 400, headers: { 'Content-Type': 'application/json' } }
            );
        }

        if (!baseUrl) {
            return new Response(
                JSON.stringify({ error: '请先填写 Gemini 原生 API 地址（通常以 /v1beta 结尾）', code: 'NO_BASE_URL_GEMINI' }),
                { status: 400, headers: { 'Content-Type': 'application/json' } }
            );
        }

        // 使用 streamGenerateContent 端点 + alt=sse
        const url = `${baseUrl}/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;

        // Gemini 3 / 4 用 thinkingLevel，2.5 用 thinkingBudget（两者同时发会 400）
        const thinkingConfig = buildGeminiThinkingConfig(model, reasoningEffort);
        const requestBody = {
            system_instruction: {
                parts: [{ text: applyContentSafety(systemPrompt) }]
            },
            contents: [
                {
                    role: 'user',
                    parts: [{ text: userPrompt }]
                }
            ],
            generationConfig: {
                ...(temperature != null ? { temperature } : {}),
                ...(topP != null ? { topP } : {}),
                ...(maxTokens ? { maxOutputTokens: maxTokens } : {}),
                ...(thinkingConfig ? { thinkingConfig } : {}),
            },
        };

        // 内置工具（仅在用户明确开启时才添加，默认不影响原有行为）
        const geminiTools = [];
        if (toolsConfig?.googleSearch) geminiTools.push({ googleSearch: {} });
        if (toolsConfig?.codeExecution) geminiTools.push({ codeExecution: {} });
        if (geminiTools.length > 0) requestBody.tools = geminiTools;

        const response = await proxyFetch(url, {
            method: 'POST', signal,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
        }, proxyUrl);

        if (!response.ok) {
            const errorText = await response.text();
            console.error('Gemini API错误:', response.status);

            let errMsg = '';
            let code = '';
            let detail = '';
            if (isInsufficientBalanceError(errorText)) {
                errMsg = 'API 账户余额不足，请充值后重试'; code = 'AI_INSUFFICIENT_QUOTA';
            } else if (response.status === 400) {
                try {
                    const errObj = JSON.parse(errorText);
                    detail = safeUpstreamDetail(errObj?.error?.message || errorText, 300);
                } catch { detail = safeUpstreamDetail(errorText, 300); }
                errMsg = `Gemini 请求错误：${detail}`; code = 'AI_SERVICE_ERROR';
            } else if (response.status === 401 || response.status === 403) {
                errMsg = 'API Key 无效或无权限，请检查你的 Gemini API Key'; code = 'INVALID_KEY';
            } else if (response.status === 429) {
                errMsg = '请求频率过高或配额不足，请稍后再试'; code = 'AI_RATE_LIMIT';
            } else {
                errMsg = `Gemini 服务返回错误(${response.status})，请检查 API 配置`; code = 'AI_RETURNED_ERROR';
            }

            return new Response(
                JSON.stringify({ error: errMsg, code, status: response.status, detail }),
                { status: response.status, headers: { 'Content-Type': 'application/json' } }
            );
        }

        return streamAiResponse(response, lifecycle, createGeminiMapper());

    } catch (error) {
        const aborted = generationAbortResponse(lifecycle);
        if (aborted) return aborted;
        console.error('Gemini 接口错误:', error?.code || error?.name || 'UNKNOWN');
        if (isServerCredentialBlocked(error)) {
            return new Response(
                JSON.stringify({ error: error.message, code: error.code }),
                { status: 403, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }
            );
        }
        if (isOutboundRequestBlocked(error)) {
            return new Response(
                JSON.stringify({ error: error.message, code: error.code }),
                { status: 400, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }
            );
        }
        return new Response(
            JSON.stringify({ error: '网络连接失败，请检查 API 地址是否正确', code: 'NETWORK_ERROR_CHECK' }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    } finally {
        if (!lifecycle.streaming) lifecycle.dispose();
    }
}

export const POST = withApiResources('/api/ai/gemini', handlePOST);
