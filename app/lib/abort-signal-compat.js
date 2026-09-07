'use client';

// ==================== AbortSignal 兼容层 ====================
// AbortSignal.any() 要到 Chrome 116 / Safari 17.4 / Firefox 124 才有，
// AbortSignal.timeout() 要到 Chrome 103 / Safari 16。官网访客里仍有大量停在
// iOS 16、iOS 17.0–17.3 和国产套壳浏览器旧内核的设备：那里 AbortSignal.any 不存在，
// serializeSync() / authorizedFetch() 第一步就抛 "AbortSignal.any is not a function"，
// 整条云同步链路（拉取 / 推送 / 授权请求）直接失效。
//
// 本模块只做运行时能力检测后的等价降级：有原生实现一律走原生，没有才用
// AbortController 组合出同样语义的信号。检测放在调用时而非模块加载时，便于测试替换。

// 组合多个信号：任一 abort 则结果 abort，并透传其 reason。
export function anySignal(signals) {
    const sources = (signals || []).filter(Boolean);
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') return AbortSignal.any(sources);
    // 单来源直接复用，省掉一次监听（降级路径的监听要挂到 abort 才摘除）。
    if (sources.length === 1) return sources[0];

    const controller = new AbortController();
    const alreadyAborted = sources.find(signal => signal.aborted);
    if (alreadyAborted) {
        controller.abort(alreadyAborted.reason);
        return controller.signal;
    }
    // 降级路径对来源持强引用（原生实现用弱引用）：来源 abort 时立刻摘除全部监听，
    // 同步链路的来源是会话级对象（登录态 / 同步控制器），退出或停止同步时一并释放。
    const onAbort = event => {
        for (const signal of sources) signal.removeEventListener('abort', onAbort);
        controller.abort(event?.target?.reason);
    };
    for (const signal of sources) signal.addEventListener('abort', onAbort);
    return controller.signal;
}

// 超时信号：超时后以 TimeoutError abort（与原生 AbortSignal.timeout 的 reason 对齐）。
export function timeoutSignal(ms) {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
    const controller = new AbortController();
    setTimeout(() => controller.abort(timeoutReason()), ms);
    return controller.signal;
}

function timeoutReason() {
    try {
        return new DOMException('signal timed out', 'TimeoutError');
    } catch {
        const error = new Error('signal timed out');
        error.name = 'TimeoutError';
        return error;
    }
}
