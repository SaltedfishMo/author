import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const { portableStandaloneMetadata } = createRequire(import.meta.url)('../scripts/standalone-metadata.cjs');

function fixture(root, lineEnding = '\n') {
    const config = {
        outputFileTracingRoot: root,
        repoRoot: root,
        turbopack: { root, resolveAlias: { example: './example.js' } },
        distDir: './.next',
        env: { NEXT_PUBLIC_APP_VERSION: '1.2.56' },
        basePath: '',
    };
    const server = [
        "const path = require('path')",
        'const dir = path.join(__dirname)',
        'process.chdir(__dirname)',
        `const nextConfig = ${JSON.stringify(config)}`,
        'process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(nextConfig)',
        'globalThis.started = { dir, config: nextConfig }',
    ].join(lineEnding);
    const manifest = JSON.stringify({ version: 1, appDir: root, relativeAppDir: '', config, files: ['.next/BUILD_ID'] });
    return { server, manifest };
}

for (const [platform, buildRoot, installRoot, pathApi, lineEnding] of [
    ['Windows', 'C:\\Users\\Builder\\workspace', 'D:\\Apps\\Author\\resources\\standalone', path.win32, '\r\n'],
    ['POSIX', '/home/builder/workspace', '/opt/Author/resources/standalone', path.posix, '\n'],
]) {
    test(`${platform} runtime locations resolve from the installation directory`, () => {
        const original = fixture(buildRoot, lineEnding);
        const result = portableStandaloneMetadata(original.server, original.manifest);
        const context = { __dirname: installRoot, require: name => { assert.equal(name, 'path'); return pathApi; }, process: { env: {}, chdir: () => {} } };
        vm.runInNewContext(result.server, context);
        const config = JSON.parse(context.process.env.__NEXT_PRIVATE_STANDALONE_CONFIG);
        assert.equal(context.started.dir, installRoot);
        assert.equal(config.outputFileTracingRoot, installRoot);
        assert.equal(config.repoRoot, installRoot);
        assert.equal(config.turbopack.root, installRoot);
        assert.equal(config.turbopack.resolveAlias.example, './example.js');
        assert.equal(config.env.NEXT_PUBLIC_APP_VERSION, '1.2.56');
        assert.equal(config.distDir, './.next');
        const manifest = JSON.parse(result.manifest);
        assert.equal(manifest.appDir, '.');
        assert.equal(manifest.config.repoRoot, '.');
        assert.deepEqual(manifest.files, ['.next/BUILD_ID']);
        assert.ok(!result.server.includes(JSON.stringify(buildRoot).slice(1, -1)));
        assert.deepEqual(portableStandaloneMetadata(result.server, result.manifest), result);
    });
}

test('unrecognized build-root uses fail without changing unrelated configuration', () => {
    const original = fixture('/home/builder/workspace');
    const manifest = JSON.parse(original.manifest);
    manifest.config.env.EXTRA_ASSET = '/home/builder/workspace/private/file';
    assert.throws(() => portableStandaloneMetadata(original.server, JSON.stringify(manifest)), /unhandled build-root reference/);
});

test('nested application roots require explicit support', () => {
    const original = fixture('/home/builder/workspace');
    const manifest = JSON.parse(original.manifest);
    manifest.relativeAppDir = 'packages/app';
    assert.throws(() => portableStandaloneMetadata(original.server, JSON.stringify(manifest)), /single application root/);
    manifest.relativeAppDir = '';
    manifest.config.turbopack.root = '/different/root';
    assert.throws(() => portableStandaloneMetadata(original.server, JSON.stringify(manifest)), /different build root/);
});

test('unexpected server templates fail before producing replacement files', () => {
    const original = fixture('/home/builder/workspace');
    assert.throws(() => portableStandaloneMetadata('const changedTemplate = true', original.manifest), /server format/);
});
