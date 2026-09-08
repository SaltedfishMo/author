import { registerHooks } from 'node:module';

const authUrl = new URL('../../app/lib/custom-auth.js', import.meta.url);
const syncUrl = new URL('../../app/lib/custom-server-sync.js', import.meta.url);
let instance = 0;
export const SERVER_A = 'https://sync-a.example.test';
export const SERVER_B = 'https://sync-b.example.test';
export const PRODUCT = 'author_free';
export const SESSION_KEY = 'author-cloud-session';
export const CONFIG_KEY = 'author-cloud-config';

export function session(userId = 'user-a', serverUrl = SERVER_A) {
    return {
        serverUrl, product: PRODUCT,
        user: { id: userId, email: `${userId}@example.test` },
        tokens: { accessToken: `synthetic-access-${userId}`, refreshToken: `synthetic-refresh-${userId}` },
    };
}

export const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status });

export async function cloudFixture(t, { saved = session(), serverUrl = SERVER_A } = {}) {
    const id = ++instance;
    const storage = new Map([[CONFIG_KEY, JSON.stringify({ serverUrl })]]);
    if (saved) storage.set(SESSION_KEY, JSON.stringify(saved));
    const values = new Map();
    const requests = [];
    const listeners = new Map();
    const window = { addEventListener: (name, callback) => {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name).add(callback);
    } };
    const globals = { window, document: { hidden: false, addEventListener() {} }, localStorage: {
        getItem: key => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
        removeItem: key => storage.delete(key),
    } };
    const originals = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
        for (const [key, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    });
    const previousDefault = process.env.NEXT_PUBLIC_AUTHOR_CLOUD_URL;
    delete process.env.NEXT_PUBLIC_AUTHOR_CLOUD_URL;
    t.after(() => {
        if (previousDefault === undefined) delete process.env.NEXT_PUBLIC_AUTHOR_CLOUD_URL;
        else process.env.NEXT_PUBLIC_AUTHOR_CLOUD_URL = previousDefault;
    });
    const env = {
        loginUser: 'user-b',
        fetch: async url => {
            if (url.endsWith('/session')) return jsonResponse({ ok: true, ...session(env.loginUser) });
            return jsonResponse({ ok: true });
        },
    };
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        const request = { url: String(url), options };
        requests.push(request);
        return env.fetch(request.url, options);
    });
    const i18nUrl = 'data:text/javascript,export function localizedError(zh) { return new Error(zh); }';
    const authInstance = `${authUrl.href}?fixture=${id}`;
    function hooks() {
        return registerHooks({ resolve(specifier, context, nextResolve) {
            if (context.parentURL === authInstance) {
                if (specifier === './runtime-i18n') return { url: i18nUrl, shortCircuit: true };
                if (specifier.startsWith('./') && !/[.][cm]?js$/.test(specifier)) return nextResolve(new URL(specifier + '.js', authUrl).href, context);
            }
            if (context.parentURL?.startsWith(syncUrl.href)) {
                if (specifier === './custom-auth') return { url: authInstance, shortCircuit: true };
                if (specifier.startsWith('./')) return nextResolve(new URL(`${specifier}.js`, syncUrl).href, context);
            }
            return nextResolve(specifier, context);
        } });
    }
    const hook = hooks();
    let auth;
    try { auth = await import(authInstance); }
    finally { hook.deregister(); }
    return {
        auth, env, storage, values, window, requests,
        fireStorage: key => { for (const callback of listeners.get('storage') || []) callback({ key }); },
        async loadSync() {
            t.mock.method(globalThis, 'setInterval', () => 1);
            t.mock.method(globalThis, 'clearInterval', () => {});
            t.mock.method(globalThis, 'setTimeout', () => 1);
            t.mock.method(globalThis, 'clearTimeout', () => {});
            const hook = hooks();
            let sync;
            try { sync = await import(`${syncUrl.href}?fixture=${id}`); }
            finally { hook.deregister(); }
            sync.bindLocalIO(
                async key => { await env.beforeRead?.(key); return structuredClone(values.get(key)); },
                async (key, value, options) => {
                    await env.beforeWrite?.(key);
                    options?.assertCurrent?.();
                    values.set(key, structuredClone(value));
                },
            );
            return sync;
        },
    };
}
