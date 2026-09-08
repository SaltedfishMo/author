const fs = require('node:fs');
const path = require('node:path');

const runtimeRoots = [
    'nextConfig.outputFileTracingRoot = dir',
    'nextConfig.repoRoot = dir',
    'if (nextConfig.turbopack) nextConfig.turbopack.root = dir',
].join('\n');

function portableStandaloneMetadata(serverSource, manifestSource) {
    const configLine = /^const nextConfig = (\{[^\r\n]*\});?\r?$/m;
    const match = configLine.exec(serverSource);
    const environmentLine = 'process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(nextConfig)';
    if (!match || !serverSource.includes(environmentLine) || !serverSource.includes('const dir = path.join(__dirname)')) {
        throw new Error('Unsupported standalone server format.');
    }
    const config = JSON.parse(match[1]);
    const manifest = JSON.parse(manifestSource);
    if (!manifest.config || manifest.relativeAppDir !== '' || typeof manifest.appDir !== 'string') {
        throw new Error('Standalone metadata requires a single application root.');
    }

    const buildRoots = new Set();
    const normalizeRoot = value => value.replaceAll('\\', '/').replace(/\/$/, '');
    const applicationRoot = normalizeRoot(manifest.appDir);
    function portableRoot(value) {
        if (value === undefined) return;
        if (typeof value !== 'string' || (value !== '.' && normalizeRoot(value) !== applicationRoot)) {
            throw new Error('Standalone metadata contains a different build root.');
        }
        if (value !== '.') buildRoots.add(value);
    }
    function normalizeConfig(value) {
        for (const key of ['outputFileTracingRoot', 'repoRoot']) {
            portableRoot(value[key]);
            if (value[key] !== undefined) value[key] = '.';
        }
        if (value.turbopack?.root !== undefined) {
            portableRoot(value.turbopack.root);
            value.turbopack.root = '.';
        }
    }
    portableRoot(manifest.appDir);
    normalizeConfig(config);
    normalizeConfig(manifest.config);
    manifest.appDir = '.';

    let server = serverSource.replace(configLine, () => `const nextConfig = ${JSON.stringify(config)}`);
    if (!server.includes(runtimeRoots)) {
        server = server.replace(environmentLine, `${runtimeRoots}\n\n${environmentLine}`);
    }
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    for (const root of buildRoots) {
        for (const candidate of new Set([root, root.replaceAll('\\', '/'), root.replaceAll('/', '\\')])) {
            const escaped = JSON.stringify(candidate).slice(1, -1);
            if (server.includes(candidate) || server.includes(escaped) || manifestText.includes(candidate) || manifestText.includes(escaped)) {
                throw new Error('Standalone metadata retains an unhandled build-root reference.');
            }
        }
    }
    return { server, manifest: manifestText };
}

function prepareStandaloneMetadata(standaloneDirectory) {
    const serverFile = path.join(standaloneDirectory, 'server.js');
    const manifestFile = path.join(standaloneDirectory, '.next', 'required-server-files.json');
    const result = portableStandaloneMetadata(fs.readFileSync(serverFile, 'utf8'), fs.readFileSync(manifestFile, 'utf8'));
    fs.writeFileSync(serverFile, result.server);
    fs.writeFileSync(manifestFile, result.manifest);
}

module.exports = { portableStandaloneMetadata, prepareStandaloneMetadata };
