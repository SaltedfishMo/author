'use strict';

const http = require('http');
const os = require('os');

// 桌面端内置服务只监听 127.0.0.1，且每个接口都要桌面凭据，手机够不着。
// 创建局域网分享时才开这个网关：它只把"凭分享码读取快照"转给内置服务，
// 其他任何请求都 404，分享全部到期后自动关闭。
const LAN_SHARE_PATH = '/api/sync/lan';
const LAN_SHARE_TOKEN_RE = /^[0-9a-f]{32}$/;
const MAX_SHARE_LIFETIME_MS = 2 * 60 * 60 * 1000; // 与 /api/sync/lan 的 MAX_TTL_MS 一致
const CLOSE_GRACE_MS = 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 15 * 1000;
const PORT_ATTEMPTS = 10;
// 浏览器拒绝访问这些端口（https://fetch.spec.whatwg.org/#port-blocking），
// 另一台电脑上的 Author 用链接导入时会失败，网关不能落在上面。
const BROWSER_BLOCKED_PORTS = new Set([
    1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
    101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179,
    389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601,
    636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566,
    6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);
const FORWARDED_RESPONSE_HEADERS = [
    'content-type',
    'content-length',
    'cache-control',
    'access-control-allow-origin',
    'retry-after',
];

function isLanShareToken(value) {
    return typeof value === 'string' && LAN_SHARE_TOKEN_RE.test(value);
}

// 返回要转发给内置服务的路径；不是"GET 读取分享"就返回 null。
// 路径由分享码重新拼出，客户端带来的其他参数和请求头一概不转发。
function lanShareUpstreamPath(method, rawUrl) {
    if (method !== 'GET') return null;
    let url;
    try {
        url = new URL(String(rawUrl || ''), 'http://lan-share.invalid');
    } catch {
        return null;
    }
    if (url.pathname !== LAN_SHARE_PATH) return null;
    const token = url.searchParams.get('token');
    return isLanShareToken(token) ? `${LAN_SHARE_PATH}?token=${token}` : null;
}

function listLanAddresses(interfaces = os.networkInterfaces()) {
    const addresses = new Set();
    for (const entries of Object.values(interfaces || {})) {
        for (const entry of entries || []) {
            const ipv4 = entry?.family === 'IPv4' || entry?.family === 4;
            if (ipv4 && !entry.internal && entry.address) addresses.add(entry.address);
        }
    }
    return [...addresses];
}

function buildLanShareUrls(addresses, port, token) {
    return addresses.map(address => `http://${address}:${port}${LAN_SHARE_PATH}?token=${token}`);
}

function createLanShareGateway({
    getUpstream,
    listenHost = '0.0.0.0',
    getAddresses = listLanAddresses,
    log = () => {},
    now = Date.now,
    closeGraceMs = CLOSE_GRACE_MS,
} = {}) {
    if (typeof getUpstream !== 'function') throw new Error('LAN share gateway needs an upstream');

    let server = null;
    let listeningPort = null;
    let starting = null;
    let closeTimer = null;
    let closeAt = 0;

    function respond(res, status, body) {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(body));
    }

    function handleRequest(req, res) {
        const upstreamPath = lanShareUpstreamPath(req.method, req.url);
        if (!upstreamPath) {
            respond(res, 404, { error: 'Not found' });
            return;
        }

        const { port, capability } = getUpstream();
        const headers = { accept: 'application/json' };
        if (capability) headers.cookie = `author-desktop-capability=${capability}`;
        const upstream = http.request({
            host: '127.0.0.1',
            port,
            method: 'GET',
            path: upstreamPath,
            headers,
            timeout: UPSTREAM_TIMEOUT_MS,
        }, (upstreamRes) => {
            const forwarded = {};
            for (const name of FORWARDED_RESPONSE_HEADERS) {
                if (upstreamRes.headers[name] !== undefined) forwarded[name] = upstreamRes.headers[name];
            }
            res.writeHead(upstreamRes.statusCode || 502, forwarded);
            upstreamRes.pipe(res);
        });
        upstream.on('timeout', () => upstream.destroy(new Error('Upstream timed out')));
        upstream.on('error', (error) => {
            log(`[LanShare] Upstream error: ${error?.message || error}`);
            if (!res.headersSent) respond(res, 502, { error: 'LAN share unavailable' });
            else res.destroy();
        });
        res.on('close', () => upstream.destroy());
        upstream.end();
    }

    function listenOn(port) {
        return new Promise((resolve, reject) => {
            const candidate = http.createServer(handleRequest);
            candidate.headersTimeout = 10 * 1000;
            candidate.requestTimeout = 30 * 1000;
            candidate.keepAliveTimeout = 5 * 1000;
            candidate.maxConnections = 32;
            candidate.once('error', reject);
            candidate.listen(port, listenHost, () => {
                candidate.removeListener('error', reject);
                candidate.on('error', error => log(`[LanShare] Gateway error: ${error?.message || error}`));
                resolve(candidate);
            });
        });
    }

    async function start() {
        // 优先用内置服务端口 +1（通常是 3001），方便用户记；都被占用就让系统挑一个。
        const base = Number(getUpstream().port) + 1;
        const ports = [];
        for (let offset = 0; offset < PORT_ATTEMPTS && base + offset <= 65535; offset++) {
            if (!BROWSER_BLOCKED_PORTS.has(base + offset)) ports.push(base + offset);
        }
        for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt++) ports.push(0);

        let lastError = null;
        for (const port of ports) {
            let candidate;
            try {
                candidate = await listenOn(port);
            } catch (error) {
                lastError = error;
                if (error?.code !== 'EADDRINUSE' && error?.code !== 'EACCES') break;
                continue;
            }
            if (BROWSER_BLOCKED_PORTS.has(candidate.address().port)) {
                candidate.close();
                continue;
            }
            server = candidate;
            listeningPort = candidate.address().port;
            log(`[LanShare] Gateway listening on ${listenHost}:${listeningPort}`);
            return;
        }
        throw lastError || new Error('LAN share gateway failed to start');
    }

    function scheduleClose(expiresAt) {
        const until = Math.min(expiresAt, now() + MAX_SHARE_LIFETIME_MS) + closeGraceMs;
        if (until <= closeAt) return;
        closeAt = until;
        clearTimeout(closeTimer);
        closeTimer = setTimeout(close, Math.max(0, closeAt - now()));
        closeTimer.unref?.();
    }

    async function open({ token, expiresAt } = {}) {
        if (!isLanShareToken(token)) throw new Error('Invalid LAN share token');
        const expires = Number(expiresAt);
        if (!Number.isFinite(expires) || expires <= now()) throw new Error('Invalid LAN share expiry');
        if (!server) {
            starting ||= start().finally(() => { starting = null; });
            await starting;
        }
        scheduleClose(expires);
        return { port: listeningPort, urls: buildLanShareUrls(getAddresses(), listeningPort, token) };
    }

    function close() {
        clearTimeout(closeTimer);
        closeTimer = null;
        closeAt = 0;
        if (!server) return;
        const closing = server;
        server = null;
        listeningPort = null;
        closing.close();
        closing.closeAllConnections?.();
        log('[LanShare] Gateway closed');
    }

    return {
        open,
        close,
        get port() { return listeningPort; },
    };
}

module.exports = {
    LAN_SHARE_PATH,
    isLanShareToken,
    lanShareUpstreamPath,
    listLanAddresses,
    buildLanShareUrls,
    createLanShareGateway,
};
