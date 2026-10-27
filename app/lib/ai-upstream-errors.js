// 上游 AI 服务商错误体的识别（服务端用）。
// 各家余额不足的写法不一：HTTP 状态码可能是 400/402/403/429，
// 所以只看错误体里的 message / code / type，不看状态码。

// 只收明确指向“账户没钱 / 欠费”的说法；单独的 quota 也可能只是限流，不放进来
const BALANCE_TEXT = /insufficient[\s_-]*(?:account[\s_-]*)?balance|balance[\s_-]*(?:is[\s_-]*)?(?:insufficient|not[\s_-]*enough)|credit[\s_-]*balance[\s_-]*is[\s_-]*too[\s_-]*low|overdue[\s_-]*balance|account[\s_-]*overdue|insufficient[\s_-]*(?:user[\s_-]*)?quota|exceeded[\s_-]*current[\s_-]*quota|余额不足|余额已用尽|账户欠费|已欠费/i;

// MiniMax 用 base_resp.status_code = 1008 表示余额不足
const MINIMAX_INSUFFICIENT_BALANCE = 1008;

function upstreamErrorFields(errorText) {
    let body;
    try { body = JSON.parse(errorText); }
    catch { return [errorText]; }
    if (!body || typeof body !== 'object') return [errorText];
    const error = body.error && typeof body.error === 'object' ? body.error : { message: body.error };
    return [
        error.message, error.code, error.type,
        body.message, body.code, body.type,
        body.errors?.message, body.base_resp?.status_msg,
    ];
}

export function isInsufficientBalanceError(errorText = '') {
    const raw = String(errorText || '').slice(0, 4000);
    if (!raw) return false;
    try {
        if (Number(JSON.parse(raw)?.base_resp?.status_code) === MINIMAX_INSUFFICIENT_BALANCE) return true;
    } catch { /* plain text */ }
    return upstreamErrorFields(raw).some(value => typeof value === 'string' && BALANCE_TEXT.test(value));
}
