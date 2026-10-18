import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { createExitController } = require('../electron/exit-controller.cjs');
const main = readFileSync(new URL('../electron/main.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
// Exercise the actual IPC, updater, and app event wiring without running a server,
// writing user files, or starting an update installer.
const trustCode = main.slice(main.indexOf('function assertTrustedIpcSender('), main.indexOf('function rememberRendererDiagnostic('));
const closeCode = main.slice(main.indexOf("    mainWindow.on('close', exitController.handleClose)"), main.indexOf('\n}\n\n// 检测端口是否可用'));
const updaterCode = main.slice(main.indexOf('function setupAutoUpdater()'), main.indexOf("\napp.on('second-instance'"));
const lifecycleCode = main.slice(main.indexOf("app.on('window-all-closed'"));
assert.ok(trustCode && closeCode && updaterCode && lifecycleCode, 'Main-process test boundaries must exist');

function fixture() {
    const events = [];
    const messages = [];
    const app = new EventEmitter();
    const window = new EventEmitter();
    const ipcMain = new EventEmitter();
    const handlers = new Map();
    ipcMain.handle = (name, handler) => handlers.set(name, handler);
    const updater = new EventEmitter();
    const context = {
        app, mainWindow: window, ipcMain, isDev: false, log() {},
        serverIdentityVerified: true,
        lanShareGateway: { close() {} },
        isTrustedAppUrl: url => url === 'http://localhost:33372/',
        sanitizeLogText: String,
        require: name => { assert.equal(name, 'electron-updater'); return { autoUpdater: updater }; },
        setTimeout() {}, // Never run the automatic network check in a unit test.
    };
    app.isPackaged = true;
    app.alive = true;
    app.quitting = false;
    window.destroyed = false;
    window.isDestroyed = () => window.destroyed;
    window.webContents = { send: (...args) => messages.push(args) };
    const cancelable = () => ({ defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });
    app.quit = () => {
        const event = cancelable();
        app.emit('before-quit', event);
        if (event.defaultPrevented) return;
        app.quitting = true;
        if (!window.destroyed) window.close();
        if (window.destroyed) {
            app.emit('will-quit', cancelable());
            app.alive = false;
            events.push('quit');
        }
        app.quitting = false;
    };
    window.close = () => {
        if (window.destroyed) return;
        const event = cancelable();
        window.emit('close', event);
        if (event.defaultPrevented) return;
        window.destroyed = true;
        events.push('closed');
        window.emit('closed');
        if (!app.quitting) app.emit('window-all-closed');
    };
    const backend = { alive: true, kill() { this.alive = false; context.serverIdentityVerified = false; events.push('stop-backend'); } };
    context.serverProcess = backend;
    context.exitController = createExitController(() => context.mainWindow);
    updater.downloadUpdate = async () => { updater.emit('update-downloaded', { version: 'test' }); };
    updater.quitAndInstall = () => { events.push('install'); app.quit(); };
    vm.runInNewContext(`${trustCode}\n${closeCode}\n${updaterCode}\n${lifecycleCode}\nsetupAutoUpdater();`, context);
    const trusted = { sender: window.webContents, senderFrame: { url: 'http://localhost:33372/' } };
    return {
        app, window, backend, context, events, messages, updater,
        confirmCount: () => messages.filter(([name]) => name === 'confirm-exit-sync').length,
        send: (name, event = trusted) => ipcMain.emit(name, event),
        invoke: (name, event = trusted) => handlers.get(name)(event),
    };
}

test('app.quit keeps the backend trusted until saved exit is approved', async () => {
    const f = fixture();
    f.app.quit();
    assert.equal(f.confirmCount(), 1);
    assert.equal(f.backend.alive, true);
    assert.equal(f.context.serverIdentityVerified, true);
    await Promise.resolve(); // Renderer completes its pending local write first.
    f.events.push('saved');
    f.send('allow-close');
    assert.equal(f.app.alive, false);
    assert.deepEqual(f.events, ['saved', 'closed', 'stop-backend', 'quit']);
});

test('repeated quit does not reset a save/sync confirmation; cancel leaves a usable app', () => {
    const f = fixture();
    f.app.quit();
    f.app.quit();
    f.window.close();
    assert.equal(f.confirmCount(), 1);
    f.send('cancel-close');
    assert.equal(f.app.alive, true);
    assert.equal(f.backend.alive, true);
    assert.equal(f.context.serverIdentityVerified, true);
    f.app.quit();
    assert.equal(f.confirmCount(), 2);
    f.send('allow-close');
    assert.equal(f.app.alive, false);
});

test('normal window close follows the same confirmation and stops the backend once', () => {
    const f = fixture();
    f.window.close();
    assert.equal(f.backend.alive, true);
    f.send('allow-close');
    f.send('allow-close');
    assert.equal(f.events.filter(e => e === 'stop-backend').length, 1);
    assert.equal(f.app.alive, false);
});

test('unrequested and untrusted close approvals cannot close the window', () => {
    const f = fixture();
    f.send('allow-close');
    assert.equal(f.window.destroyed, false);
    f.app.quit();
    f.send('allow-close', { sender: {}, senderFrame: { url: 'http://localhost:33372/' } });
    f.send('cancel-close', { sender: f.window.webContents, senderFrame: { url: 'https://untrusted.example/' } });
    f.app.quit();
    assert.equal(f.confirmCount(), 1);
    assert.equal(f.backend.alive, true);
    f.send('allow-close');
    assert.equal(f.app.alive, false);
});

test('explicit update install waits for saved exit and installs only once', () => {
    const f = fixture();
    f.invoke('quit-and-install');
    f.invoke('quit-and-install');
    assert.equal(f.confirmCount(), 1);
    assert.deepEqual(f.events, []);
    assert.equal(f.backend.alive, true);
    f.events.push('saved');
    f.send('allow-close');
    assert.deepEqual(f.events, ['saved', 'install', 'closed', 'stop-backend', 'quit']);
});

test('canceling update exit drops the pending explicit installer action', () => {
    const f = fixture();
    f.invoke('quit-and-install');
    f.send('cancel-close');
    f.window.close();
    f.send('allow-close');
    assert.equal(f.events.includes('install'), false);
    assert.equal(f.app.alive, false);
});

test('installer error restores close confirmation and keeps the backend alive', () => {
    const f = fixture();
    f.updater.quitAndInstall = () => f.updater.emit('error', new Error('synthetic installer failure'));
    f.invoke('quit-and-install');
    f.send('allow-close');
    assert.equal(f.app.alive, true);
    assert.equal(f.backend.alive, true);
    f.window.close();
    assert.equal(f.confirmCount(), 2);
    f.send('allow-close');
    assert.equal(f.app.alive, false);
});

test('download-and-install waits for confirmation and failed downloads leave no exit listener', async () => {
    const f = fixture();
    f.updater.downloadUpdate = async () => { throw new Error('synthetic download failure'); };
    assert.equal((await f.invoke('download-and-install-update')).success, false);
    f.updater.emit('update-downloaded', { version: 'test' });
    assert.equal(f.confirmCount(), 0);
    f.updater.downloadUpdate = async () => { f.updater.emit('update-downloaded', { version: 'test' }); };
    assert.equal((await f.invoke('download-and-install-update')).success, true);
    assert.equal(f.confirmCount(), 1);
    assert.deepEqual(f.events, []);
    f.send('allow-close');
    assert.equal(f.events[0], 'install');
    assert.equal(f.app.alive, false);
});

test('an explicitly approved native crash exit does not wait for the failed renderer', () => {
    const f = fixture();
    f.app.quit();
    f.context.exitController.approveNativeExit();
    f.app.quit();
    assert.equal(f.confirmCount(), 1);
    assert.equal(f.app.alive, false);
    assert.equal(f.backend.alive, false);
});
