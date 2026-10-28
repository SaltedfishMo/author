import assert from 'node:assert/strict';
import test from 'node:test';

import { isInsufficientBalanceError } from '../app/lib/ai-upstream-errors.js';

const json = value => JSON.stringify(value);

test('insufficient balance is recognized across provider error shapes', () => {
    const samples = {
        deepseek: json({ error: { message: 'Insufficient Balance', type: 'unknown_error', param: null, code: 'invalid_request_error' } }),
        minimaxMessage: json({ type: 'error', error: { type: 'insufficient_balance_error', message: 'insufficient balance (1008)', http_code: '402' } }),
        minimaxBaseResp: json({ id: 'x', choices: null, base_resp: { status_code: 1008, status_msg: '' } }),
        zhipu: json({ error: { code: '1113', message: '余额不足或无可用资源包,请充值。' } }),
        siliconflow: json({ code: 30001, message: 'Sorry, your account balance is insufficient', data: null }),
        anthropic: json({ type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }),
        openai: json({ error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', code: 'insufficient_quota' } }),
        moonshot: json({ error: { message: 'Your account is suspended, please check your plan and billing details', type: 'exceeded_current_quota_error' } }),
        relay: json({ error: { message: '用户额度不足, 剩余额度: $0.0', type: 'new_api_error', code: 'insufficient_user_quota' } }),
        volcengine: json({ error: { code: 'AccountOverdueError', message: 'The request failed because your account has an overdue balance.', type: 'Forbidden' } }),
        plainText: 'Insufficient Balance',
    };
    for (const [name, body] of Object.entries(samples)) {
        assert.equal(isInsufficientBalanceError(body), true, name);
    }
});

test('rate limits, auth and context errors are not reported as insufficient balance', () => {
    const samples = {
        empty: '',
        geminiRateLimit: json({ error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED' } }),
        openaiRateLimit: json({ error: { message: 'Rate limit reached for requests', type: 'requests', code: 'rate_limit_exceeded' } }),
        invalidKey: json({ error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } }),
        contextTooLong: json({ error: { message: "This model's maximum context length is 128000 tokens.", code: 'context_length_exceeded' } }),
        minimaxOtherCode: json({ base_resp: { status_code: 1002, status_msg: 'rate limit' } }),
        htmlGateway: '<html><body>502 Bad Gateway</body></html>',
    };
    for (const [name, body] of Object.entries(samples)) {
        assert.equal(isInsufficientBalanceError(body), false, name);
    }
});
