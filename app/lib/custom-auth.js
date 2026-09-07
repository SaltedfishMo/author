'use client';

// ==================== Author Cloud Auth 封装 ====================
// 仅调用后端 HTTP API，不含任何服务端实现，不硬编码任何密钥。
// 服务器地址可配置：默认读环境变量 NEXT_PUBLIC_AUTHOR_CLOUD_URL，允许用户覆盖
// （自托管），支持公开开源分发。

import { anySignal, timeoutSignal } from './abort-signal-compat';
import { localizedError } from './runtime-i18n';
import {
    isOfficialAuthorCloudUrl,
    normalizeCloudServerUrl,
    resolveCloudServerUrl,
} from './cloud-server-policy.mjs';

const PRODUCT = 'author_free';
const SESSION_KEY = 'author-cloud-session';         // 本地令牌 + 用户，绝不上云
const SERVER_CONFIG_KEY = 'author-cloud-config';    // 用户自定义服务器地址
const CUSTOM_HISTORY_KEY = 'author-cloud-account-history';

// ==================== 服务器地址（可配） ====================

const DEFAULT_SERVER_URL = String(process.env.NEXT_PUBLIC_AUTHOR_CLOUD_URL || '').replace(/\/+$/, '');

function isElectronRuntime() {
    return typeof window !== 'undefined' && window.electronAPI?.isElectron === true;
}

export function getCloudServerUrl() {
    let configuredUrl = '';
    if (typeof window !== 'undefined') {
        try {
            const cfg = JSON.parse(localStorage.getItem(SERVER_CONFIG_KEY) || 'null');
            configuredUrl = cfg?.serverUrl || '';
        } catch {}
    }
    // Electron 只允许用户自己的同步服务器。即使官方地址被构建期注入、手动填写
    // 或残留在旧配置中，也不能从桌面端连接 Author 官方云服务。
    return resolveCloudServerUrl({
        configuredUrl,
        defaultUrl: DEFAULT_SERVER_URL,
        isElectron: isElectronRuntime(),
    });
}

export function setCloudServerUrl(url) {
    if (typeof window === 'undefined') return false;
    const clean = normalizeCloudServerUrl(url);
    if (!clean || (isElectronRuntime() && isOfficialAuthorCloudUrl(clean))) return false;
    try {
        const previous = getCloudServerUrl();
        localStorage.setItem(SERVER_CONFIG_KEY, JSON.stringify({ serverUrl: clean }));
        if (previous !== clean) {
            clearMemorySession();
            notify();
        }
        return true;
    } catch {
        return false;
    }
}

export function isCustomServerConfigured() {
    return Boolean(getCloudServerUrl());
}

// ==================== 状态管理 ====================

let _currentCustomUser = null;
let _session = null; // { tokenType, accessToken, refreshToken, accessExpiresAt, refreshExpiresAt }
let _sessionServerUrl = '';
let _sessionEpoch = 0;
let _sessionController = new AbortController();
let _refreshPromise = null;
let _initialized = false;
let _storageListenerInstalled = false;
const _listeners = new Set();

function advanceSessionEpoch() {
    _sessionController.abort();
    _sessionController = new AbortController();
    _sessionEpoch++;
    _refreshPromise = null;
}

function clearMemorySession() {
    advanceSessionEpoch();
    _currentCustomUser = null;
    _session = null;
    _sessionServerUrl = '';
}

function ensureServerBinding() {
    if (_sessionServerUrl && _sessionServerUrl !== getCloudServerUrl()) {
        clearMemorySession();
        notify();
    }
}

function captureAuthContext() {
    ensureServerBinding();
    return Object.freeze({
        serverUrl: requireServer(), product: PRODUCT,
        userId: _currentCustomUser?.id != null ? String(_currentCustomUser.id) : null,
        epoch: _sessionEpoch, signal: _sessionController.signal,
    });
}

export function getCustomAuthContext() {
    ensureServerBinding();
    return _currentCustomUser && _session?.accessToken ? captureAuthContext() : null;
}

export function isCustomAuthContextCurrent(context) {
    return Boolean(context && !context.signal.aborted
        && context.signal === _sessionController.signal
        && context.epoch === _sessionEpoch && context.product === PRODUCT
        && context.serverUrl === getCloudServerUrl()
        && context.userId === (_currentCustomUser?.id != null ? String(_currentCustomUser.id) : null));
}

export function assertCustomAuthContext(context) {
    if (isCustomAuthContextCurrent(context)) return;
    const error = localizedError('登录状态或服务器已改变，请重试', 'The session or server changed. Please try again.', 'Сеанс или сервер изменился. Повторите попытку.');
    error.code = 'AUTH_CONTEXT_CHANGED';
    throw error;
}

function notify() {
    _listeners.forEach((fn) => {
        try { fn(_currentCustomUser); } catch (e) { console.error('[custom-auth] listener error:', e); }
    });
}

function hasElectronTokenStore() {
    return typeof window !== 'undefined'
        && typeof window.electronAPI?.getCloudSessionTokens === 'function'
        && typeof window.electronAPI?.setCloudSessionTokens === 'function';
}

function readElectronTokens() {
    if (!hasElectronTokenStore()) return null;
    try {
        const result = window.electronAPI.getCloudSessionTokens();
        if (!result?.success || !result.value) return null;
        const tokens = JSON.parse(result.value);
        return tokens && typeof tokens === 'object' && !Array.isArray(tokens) ? tokens : null;
    } catch {
        return null;
    }
}

function writeElectronTokens(tokens) {
    try {
        return window.electronAPI.setCloudSessionTokens(JSON.stringify(tokens || {}))?.success === true;
    } catch {
        return false;
    }
}

function loadSession() {
    if (typeof window === 'undefined') return null;
    try {
        const saved = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
        // Legacy sessions have no trustworthy server origin. Leave them on disk
        // but require a new sign-in instead of assigning them to today's URL.
        if (saved?.serverUrl !== getCloudServerUrl() || saved?.product !== PRODUCT) return null;
        if (!hasElectronTokenStore()) return saved;

        if (saved?.tokens) {
            // One-time migration: remove plaintext tokens only after the
            // operating-system encrypted write has succeeded.
            if (writeElectronTokens({ tokens: saved.tokens, serverUrl: saved.serverUrl, product: PRODUCT, userId: String(saved.user?.id) })) {
                localStorage.setItem(SESSION_KEY, JSON.stringify({ user: saved.user, serverUrl: saved.serverUrl, product: PRODUCT }));
            } else {
                return saved;
            }
        }
        const secured = readElectronTokens();
        if (secured?.serverUrl !== saved.serverUrl || secured?.product !== PRODUCT
            || secured?.userId !== String(saved.user?.id)) return null;
        return saved?.user && secured?.tokens ? { ...saved, tokens: secured.tokens } : null;
    } catch {
        return null;
    }
}

function saveSession(data) {
    if (typeof window === 'undefined') return false;
    try {
        if (!hasElectronTokenStore()) {
            if (data) localStorage.setItem(SESSION_KEY, JSON.stringify(data));
            else localStorage.removeItem(SESSION_KEY);
            return true;
        }

        if (data) {
            if (!writeElectronTokens({ tokens: data.tokens, serverUrl: data.serverUrl, product: data.product, userId: String(data.user.id) })) return false;
            localStorage.setItem(SESSION_KEY, JSON.stringify({ user: data.user, serverUrl: data.serverUrl, product: data.product }));
        } else {
            const result = window.electronAPI.deleteCloudSessionTokens?.();
            if (result && result.success === false) return false;
            localStorage.removeItem(SESSION_KEY);
        }
        return true;
    } catch {
        if (data && hasElectronTokenStore()) {
            try { window.electronAPI.deleteCloudSessionTokens?.(); } catch {}
        }
        return false;
    }
}

// 从本地恢复会话（应用启动时调用一次）。令牌若过期，首次授权请求会自动刷新。
export function initCustomAuth() {
    if (!_storageListenerInstalled && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        _storageListenerInstalled = true;
        window.addEventListener('storage', event => {
            if (event.key !== null && event.key !== SESSION_KEY && event.key !== SERVER_CONFIG_KEY) return;
            clearMemorySession();
            _initialized = false;
            initCustomAuth();
        });
    }
    if (_initialized) { ensureServerBinding(); notify(); return; }
    _initialized = true;
    // 不删除旧会话；在桌面端没有合规自建地址时只是不加载，避免历史官方
    // Author Cloud 会话绕过当前产品边界重新显示为已登录。
    if (!getCloudServerUrl()) {
        clearMemorySession();
        notify();
        return;
    }
    const saved = loadSession();
    if (saved?.user?.id != null && saved?.tokens?.accessToken) {
        advanceSessionEpoch();
        _currentCustomUser = saved.user;
        _session = saved.tokens;
        _sessionServerUrl = saved.serverUrl;
    }
    notify();
}

export function getCurrentCustomUser() { ensureServerBinding(); return _currentCustomUser; }

export function isCustomSignedIn() { return Boolean(getCustomAuthContext()); }

export function onCustomAuthChange(callback) {
    _listeners.add(callback);
    try { callback(_currentCustomUser); } catch {}
    return () => _listeners.delete(callback);
}

// 返回界面统一使用的用户资料字段。
export function getCustomUserProfile() {
    ensureServerBinding();
    if (!_currentCustomUser) return null;
    const u = _currentCustomUser;
    return { uid: u.id, email: u.email || '', displayName: u.displayName || '', photoURL: '' };
}

// ==================== 内部：HTTP ====================

function requireServer() {
    const url = getCloudServerUrl();
    if (!url) throw localizedError('未配置同步服务器', 'Sync server is not configured.', 'Сервер синхронизации не настроен.');
    return url;
}

async function postJson(path, body, { token, context = captureAuthContext() } = {}) {
    assertCustomAuthContext(context);
    const headers = { 'content-type': 'application/json', 'x-author-product': PRODUCT };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(`${context.serverUrl}${path}`, {
        method: 'POST', headers, body: JSON.stringify(body || {}), signal: context.signal, redirect: 'error',
    });
    assertCustomAuthContext(context);
    let data = null;
    try { data = await res.json(); } catch {}
    assertCustomAuthContext(context);
    return { res, data };
}

function applyLoginResult(data, context) {
    assertCustomAuthContext(context);
    if (data?.user?.id == null || !data?.tokens?.accessToken) {
        throw localizedError('登录响应无效，请重试', 'Invalid sign-in response. Please try again.', 'Некорректный ответ при входе. Повторите попытку.');
    }
    if (!saveSession({ user: data.user, tokens: data.tokens, serverUrl: context.serverUrl, product: PRODUCT })) {
        throw localizedError(
            '无法安全保存登录会话，请检查本机存储后重试',
            'The sign-in session could not be stored securely. Check local storage and try again.',
            'Не удалось безопасно сохранить сеанс. Проверьте локальное хранилище и повторите попытку.',
        );
    }
    advanceSessionEpoch();
    _initialized = true;
    _sessionServerUrl = context.serverUrl;
    _currentCustomUser = data.user;
    _session = data.tokens;
    saveCustomAccountToHistory(data.user);
    notify();
    return _currentCustomUser;
}

// 把后端 error.code 映射为三语提示；未知则用兜底文案
function authError(data, fallbackZh, fallbackEn, fallbackRu) {
    const map = {
        invalid_credentials: ['邮箱或密码错误', 'Invalid email or password.', 'Неверная почта или пароль.'],
        email_taken: ['该邮箱已被注册', 'That email is already registered.', 'Эта почта уже зарегистрирована.'],
        weak_password: ['密码至少 8 位', 'Password must be at least 8 characters.', 'Пароль должен быть не менее 8 символов.'],
        invalid_email: ['邮箱格式不正确', 'Please enter a valid email address.', 'Введите корректный адрес почты.'],
        rate_limited: ['发送太频繁，请稍后再试', 'Too many requests. Please wait a moment.', 'Слишком часто, подождите немного.'],
        code_required: ['请先获取并填写验证码', 'Request and enter the verification code.', 'Запросите и введите код подтверждения.'],
        invalid_code: ['验证码错误', 'Incorrect verification code.', 'Неверный код подтверждения.'],
        code_expired: ['验证码已过期，请重新获取', 'Code expired, request a new one.', 'Код истёк, запросите новый.'],
        too_many_attempts: ['尝试次数过多，请重新获取验证码', 'Too many attempts, request a new code.', 'Слишком много попыток, запросите новый код.'],
        delivery_failed: ['验证码发送失败，请稍后重试', 'Failed to send the code, try again later.', 'Не удалось отправить код, попробуйте позже.'],
    };
    const m = map[data?.error?.code];
    if (m) return localizedError(m[0], m[1], m[2]);
    return localizedError(fallbackZh, fallbackEn, fallbackRu);
}

// ==================== 注册 / 登录 / 登出 ====================

export async function signUpWithCustomServer(email, password, displayName, code) {
    advanceSessionEpoch();
    const context = captureAuthContext();
    const { res, data } = await postJson('/api/auth/register', { email, password, displayName, code, product: PRODUCT }, { context });
    if (!res.ok || !data?.ok) throw authError(data, '注册失败', 'Registration failed.', 'Не удалось зарегистрироваться.');
    return applyLoginResult(data, context);
}

// 请求邮箱注册验证码。成功返回 { retryAfter }；失败 throw（三语提示；限流附带 retryAfter 秒）。
export async function sendEmailCode(email) {
    const { res, data } = await postJson('/api/auth/send-code', { email, channel: 'email', product: PRODUCT });
    if (!res.ok || !data?.ok) {
        const err = authError(data, '验证码发送失败', 'Failed to send code.', 'Не удалось отправить код.');
        if (data?.error?.retryAfter) err.retryAfter = data.error.retryAfter;
        throw err;
    }
    return { retryAfter: data.retryAfter || 60 };
}

export async function signInWithCustomServer(email, password) {
    advanceSessionEpoch();
    const context = captureAuthContext();
    const { res, data } = await postJson('/api/auth/session', { email, password, product: PRODUCT }, { context });
    if (!res.ok || !data?.ok) throw authError(data, '登录失败', 'Sign-in failed.', 'Не удалось войти.');
    return applyLoginResult(data, context);
}

export async function signOutCustom({ authContext } = {}) {
    const context = authContext || getCustomAuthContext();
    if (authContext) assertCustomAuthContext(authContext);
    const token = _session?.accessToken;
    forceLocalSignOut();
    if (context && token) {
        try {
            const response = await fetch(`${context.serverUrl}/api/auth/logout`, {
                method: 'POST', headers: { 'content-type': 'application/json', 'x-author-product': context.product, authorization: `Bearer ${token}` },
                body: '{}', redirect: 'error', signal: timeoutSignal(10000),
            });
            await response.body?.cancel();
        } catch {}
    }
}

function forceLocalSignOut() {
    clearMemorySession();
    _initialized = true;
    if (!saveSession(null)) {
        console.warn('[custom-auth] failed to clear persisted session');
    }
    notify();
}

// ==================== 令牌 & 授权请求 ====================

export function getAccessToken() { ensureServerBinding(); return _session?.accessToken || null; }

// single-flight 去重：并发的刷新复用同一次请求。否则多个同步请求在 access 过期后同时 401，
// 各自拿同一个「一次性」refreshToken 去刷新，rotation 下只有第一个成功、其余全失败 →
// authorizedFetch 误判登录失效把用户踢下线（"每次都要重登"的根因）。
function refreshSession(context) {
    assertCustomAuthContext(context);
    if (_refreshPromise?.epoch === context.epoch) return _refreshPromise.promise;
    const entry = { epoch: context.epoch };
    entry.promise = (async () => {
        const refreshToken = _session?.refreshToken;
        if (!refreshToken) return false;
        try {
            const { res, data } = await postJson('/api/auth/refresh', { refreshToken, product: PRODUCT }, { context });
            if (!res.ok || !data?.ok || !data.tokens) return false;
            assertCustomAuthContext(context);
            if (!saveSession({ user: _currentCustomUser, tokens: data.tokens, serverUrl: context.serverUrl, product: PRODUCT })) return false;
            _session = data.tokens;
            return true;
        } catch {
            assertCustomAuthContext(context);
            return false;
        }
    })().finally(() => { if (_refreshPromise === entry) _refreshPromise = null; });
    _refreshPromise = entry;
    return entry.promise;
}

// 带令牌的 fetch：遇 401 用 refresh 换新令牌重试一次；刷新失败则本地登出。
// 供 custom-server-sync 调用同步端点。
export async function authorizedFetch(path, { method = 'GET', body, query, authContext, signal } = {}) {
    const context = authContext || getCustomAuthContext();
    assertCustomAuthContext(context);
    if (!context.userId || !_session?.accessToken) throw localizedError('请先登录', 'Please sign in first.', 'Сначала войдите в аккаунт.');
    const requestSignal = signal ? anySignal([context.signal, signal]) : context.signal;
    let sentToken;
    const build = () => {
        assertCustomAuthContext(context);
        requestSignal.throwIfAborted();
        sentToken = _session.accessToken;
        const headers = { 'x-author-product': PRODUCT };
        headers.authorization = `Bearer ${sentToken}`;
        if (body !== undefined) headers['content-type'] = 'application/json';
        let qs = '';
        if (query) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(query)) {
                if (v !== undefined && v !== null) params.set(k, String(v));
            }
            qs = `?${params.toString()}`;
        }
        return fetch(`${context.serverUrl}${path}${qs}`, {
            method,
            headers,
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: requestSignal, redirect: 'error',
        });
    };
    let res = await build();
    assertCustomAuthContext(context);
    requestSignal.throwIfAborted();
    if (res.status === 401 && _session?.refreshToken) {
        await res.body?.cancel();
        const ok = sentToken !== _session.accessToken || await refreshSession(context);
        assertCustomAuthContext(context);
        requestSignal.throwIfAborted();
        if (ok) res = await build();
        else forceLocalSignOut();
    }
    if (res.status !== 401 || _currentCustomUser) assertCustomAuthContext(context);
    return res;
}

// ==================== Author Cloud 账号历史 ====================

function saveCustomAccountToHistory(user) {
    if (typeof window === 'undefined' || !user) return;
    try {
        const list = getCustomAccountHistory();
        const i = list.findIndex((a) => a.uid === user.id);
        const entry = {
            uid: user.id,
            email: user.email || '',
            displayName: user.displayName || '',
            provider: 'custom-server',
            lastLogin: Date.now(),
        };
        if (i >= 0) list[i] = entry; else list.unshift(entry);
        localStorage.setItem(CUSTOM_HISTORY_KEY, JSON.stringify(list.slice(0, 5)));
    } catch {}
}

export function getCustomAccountHistory() {
    if (typeof window === 'undefined') return [];
    try { return JSON.parse(localStorage.getItem(CUSTOM_HISTORY_KEY) || '[]'); } catch { return []; }
}

export function removeCustomAccountFromHistory(uid) {
    if (typeof window === 'undefined') return;
    try {
        const list = getCustomAccountHistory().filter((a) => a.uid !== uid);
        localStorage.setItem(CUSTOM_HISTORY_KEY, JSON.stringify(list));
    } catch {}
}
