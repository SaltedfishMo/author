import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createRequire, registerHooks } from 'node:module';

import { listenLocal } from './helpers/local-server.mjs';

const require = createRequire(import.meta.url);
const {
    lanShareUpstreamPath,
    listLanAddresses,
    buildLanShareUrls,
    createLanShareGateway,
} = require('../electron/lan-share-gateway.cjs');

// 合成的分享码（32 位小写十六进制），不是真实凭据
const TOKEN = 'a1'.repeat(16);

test('LAN share gateway only forwards share reads by token', () => {
    assert.equal(lanShareUpstreamPath('GET', `/api/sync/lan?token=${TOKEN}`), `/api/sync/lan?token=${TOKEN}`);
    // 多余参数不转发，路径由分享码重新拼出
    assert.equal(lanShareUpstreamPath('GET', `/api/sync/lan?token=${TOKEN}&action=create`), `/api/sync/lan?token=${TOKEN}`);

    assert.equal(lanShareUpstreamPath('POST', `/api/sync/lan?token=${TOKEN}`), null);
    assert.equal(lanShareUpstreamPath('OPTIONS', `/api/sync/lan?token=${TOKEN}`), null);
    assert.equal(lanShareUpstreamPath('GET', '/api/sync/lan'), null);
    assert.equal(lanShareUpstreamPath('GET', '/api/sync/lan?token=short'), null);
    assert.equal(lanShareUpstreamPath('GET', `/api/sync/lan?token=${TOKEN.toUpperCase()}`), null);
    assert.equal(lanShareUpstreamPath('GET', `/api/storage?token=${TOKEN}`), null);
    assert.equal(lanShareUpstreamPath('GET', `/api/ai?token=${TOKEN}`), null);
    assert.equal(lanShareUpstreamPath('GET', `/api/sync/lan/../../api/storage?token=${TOKEN}`), null);
    assert.equal(lanShareUpstreamPath('GET', `/api/sync/lan/x?token=${TOKEN}`), null);
    assert.equal(lanShareUpstreamPath('GET', `/?token=${TOKEN}`), null);
});

test('LAN share links use external IPv4 addresses only', () => {
    const addresses = listLanAddresses({
        lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
        wifi: [
            { family: 'IPv4', address: '192.168.1.20', internal: false },
            { family: 'IPv6', address: 'fe80::1', internal: false },
        ],
        dup: [{ family: 4, address: '192.168.1.20', internal: false }],
        eth: [{ family: 'IPv4', address: '10.0.0.8', internal: false }],
    });
    assert.deepEqual(addresses, ['192.168.1.20', '10.0.0.8']);
    assert.deepEqual(buildLanShareUrls(addresses, 3001, TOKEN), [
        `http://192.168.1.20:3001/api/sync/lan?token=${TOKEN}`,
        `http://10.0.0.8:3001/api/sync/lan?token=${TOKEN}`,
    ]);
});

function startFakeUpstream() {
    const seen = [];
    const server = http.createServer((req, res) => {
        seen.push({ method: req.method, url: req.url, cookie: req.headers.cookie, forwardedFor: req.headers['x-forwarded-for'] });
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Set-Cookie': 'should-not-leak=1',
        });
        res.end(JSON.stringify({ type: 'author-sync-snapshot-v1', entries: [] }));
    });
    return listenLocal(server).then(() => ({ server, seen }));
}

test('LAN share gateway proxies share reads with desktop capability and rejects the rest', async (t) => {
    const { server: upstream, seen } = await startFakeUpstream();
    t.after(() => { upstream.close(); upstream.closeAllConnections(); });

    const gateway = createLanShareGateway({
        getUpstream: () => ({ port: upstream.address().port, capability: 'synthetic-capability' }),
        listenHost: '127.0.0.1',
        getAddresses: () => ['192.168.1.20'],
    });
    t.after(() => gateway.close());

    await assert.rejects(gateway.open({ token: 'bad', expiresAt: Date.now() + 60_000 }));
    await assert.rejects(gateway.open({ token: TOKEN, expiresAt: Date.now() - 1 }));
    assert.equal(gateway.port, null, 'invalid shares must not open the gateway');

    const opened = await gateway.open({ token: TOKEN, expiresAt: Date.now() + 60_000 });
    assert.equal(opened.port, gateway.port);
    assert.notEqual(opened.port, upstream.address().port);
    assert.deepEqual(opened.urls, [`http://192.168.1.20:${opened.port}/api/sync/lan?token=${TOKEN}`]);

    const base = `http://127.0.0.1:${opened.port}`;
    const ok = await fetch(`${base}/api/sync/lan?token=${TOKEN}&extra=1`, { headers: { 'X-Forwarded-For': '1.2.3.4' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('access-control-allow-origin'), '*');
    assert.equal(ok.headers.get('set-cookie'), null);
    assert.equal((await ok.json()).type, 'author-sync-snapshot-v1');

    for (const [path, method] of [
        ['/api/storage', 'GET'],
        ['/api/ai', 'POST'],
        [`/api/sync/lan?token=${TOKEN}`, 'POST'],
        ['/api/desktop-handshake', 'GET'],
        ['/', 'GET'],
    ]) {
        const res = await fetch(`${base}${path}`, { method });
        assert.equal(res.status, 404, `${method} ${path}`);
        await res.arrayBuffer();
    }

    assert.deepEqual(seen, [{
        method: 'GET',
        url: `/api/sync/lan?token=${TOKEN}`,
        cookie: 'author-desktop-capability=synthetic-capability',
        forwardedFor: undefined,
    }]);

    gateway.close();
    assert.equal(gateway.port, null);
    await assert.rejects(fetch(`${base}/api/sync/lan?token=${TOKEN}`));
});

test('LAN share gateway closes itself after the last share expires', async (t) => {
    const { server: upstream } = await startFakeUpstream();
    t.after(() => { upstream.close(); upstream.closeAllConnections(); });

    const gateway = createLanShareGateway({
        getUpstream: () => ({ port: upstream.address().port, capability: '' }),
        listenHost: '127.0.0.1',
        getAddresses: () => [],
        closeGraceMs: 0,
    });
    t.after(() => gateway.close());
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

    await gateway.open({ token: TOKEN, expiresAt: Date.now() + 400 });
    // 先到期的分享不能提前关掉网关
    await gateway.open({ token: TOKEN.replace('a', 'f'), expiresAt: Date.now() + 50 });
    await wait(200);
    assert.ok(gateway.port, 'the gateway stays open until the last share expires');
    await wait(400);
    assert.equal(gateway.port, null, 'the gateway closes after the last share expires');
});

test('LAN share gateway reports upstream failures without leaking details', async (t) => {
    const unused = http.createServer();
    const deadPort = await listenLocal(unused);
    await new Promise(resolve => unused.close(resolve));

    const gateway = createLanShareGateway({
        getUpstream: () => ({ port: deadPort, capability: 'synthetic-capability' }),
        listenHost: '127.0.0.1',
        getAddresses: () => [],
    });
    t.after(() => gateway.close());

    const { port } = await gateway.open({ token: TOKEN, expiresAt: Date.now() + 60_000 });
    const res = await fetch(`http://127.0.0.1:${port}/api/sync/lan?token=${TOKEN}`);
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: 'LAN share unavailable' });
});

// 端到端：真正的 /api/sync/lan 路由，套上桌面端同样的凭据锁。
// 直连被拒（这正是手机原来遇到的 401），经网关凭分享码能取到快照。
async function startDesktopLanRoute(t, capability) {
    const routeUrl = new URL('../app/api/sync/lan/route.js', import.meta.url);
    const mockUrl = `data:text/javascript,${encodeURIComponent(`
        export class NextResponse extends Response {
            static json(data, init) { return Response.json(data, init); }
        }
    `)}`;
    const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
        if (context.parentURL?.startsWith(routeUrl.href) && specifier === 'next/server') {
            return { url: mockUrl, shortCircuit: true };
        }
        return nextResolve(specifier, context);
    } });
    const previous = process.env.AUTHOR_DESKTOP_CAPABILITY;
    process.env.AUTHOR_DESKTOP_CAPABILITY = capability;
    t.after(() => {
        hooks.deregister();
        if (previous === undefined) delete process.env.AUTHOR_DESKTOP_CAPABILITY;
        else process.env.AUTHOR_DESKTOP_CAPABILITY = previous;
    });
    const route = await import(`${routeUrl.href}?desktop-gateway`);

    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = chunks.length ? Buffer.concat(chunks) : undefined;
        const headers = new Headers();
        for (const [name, value] of Object.entries(req.headers)) {
            if (typeof value === 'string') headers.set(name, value);
        }
        const request = new Request(`http://127.0.0.1:${server.address().port}${req.url}`, { method: req.method, headers, body });
        const response = await route[req.method](request);
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
    });
    const port = await listenLocal(server);
    t.after(() => { server.close(); server.closeAllConnections(); });
    return port;
}

test('desktop LAN share is readable through the gateway but not directly', async (t) => {
    const capability = 'synthetic-desktop-capability-0123456789';
    const port = await startDesktopLanRoute(t, capability);
    const local = `http://127.0.0.1:${port}/api/sync/lan`;
    const bundle = {
        type: 'author-sync-snapshot-v1',
        version: 1,
        entries: [{ key: 'author-chapters-work-a', value: [{ id: 1, title: '第一章' }], updatedAt: new Date().toISOString() }],
    };

    // 桌面窗口带着凭据创建分享
    const created = await fetch(local, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: `author-desktop-capability=${capability}` },
        body: JSON.stringify({ action: 'create', bundle, ttlMs: 5 * 60 * 1000 }),
    });
    assert.equal(created.status, 200);
    const share = await created.json();
    assert.ok(/^[0-9a-f]{32}$/.test(share.token));

    // 手机原来的遭遇：没有凭据，直连一律 401
    const direct = await fetch(`${local}?token=${share.token}`);
    assert.equal(direct.status, 401);
    assert.equal((await direct.json()).code, 'DESKTOP_CAPABILITY_REQUIRED');

    const gateway = createLanShareGateway({
        getUpstream: () => ({ port, capability }),
        listenHost: '127.0.0.1',
        getAddresses: () => ['192.168.1.20'],
    });
    t.after(() => gateway.close());
    const opened = await gateway.open({ token: share.token, expiresAt: share.expiresAt });
    assert.deepEqual(opened.urls, [`http://192.168.1.20:${opened.port}/api/sync/lan?token=${share.token}`]);

    const viaGateway = await fetch(`http://127.0.0.1:${opened.port}/api/sync/lan?token=${share.token}`);
    assert.equal(viaGateway.status, 200);
    assert.deepEqual(await viaGateway.json(), bundle);

    // 错的分享码经网关也只会得到"分享不存在"
    const wrong = await fetch(`http://127.0.0.1:${opened.port}/api/sync/lan?token=${'f'.repeat(32)}`);
    assert.equal(wrong.status, 404);
    assert.equal((await wrong.json()).code, 'SHARE_NOT_FOUND');
});
