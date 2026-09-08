/**
 * electron-builder afterPack hook
 * Copies node_modules from standalone into the packaged app resources,
 * because electron-builder filters out node_modules from extraResources.
 */
const path = require('path');
const fs = require('fs');
const { prepareStandaloneMetadata } = require('./scripts/standalone-metadata.cjs');

function copyDirSync(src, dest) {
    if (!fs.existsSync(src)) return;
    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            copyDirSync(srcPath, destPath);
        } else if (entry.isSymbolicLink()) {
            // Resolve symlinks and copy the actual file/dir
            const realPath = fs.realpathSync(srcPath);
            if (fs.statSync(realPath).isDirectory()) {
                copyDirSync(realPath, destPath);
            } else {
                fs.copyFileSync(realPath, destPath);
            }
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

exports.default = async function afterPack(context) {
    const appOutDir = context.appOutDir; // e.g. dist/win-unpacked
    const standaloneNodeModules = path.join(__dirname, '.next', 'standalone', 'node_modules');
    const targetNodeModules = path.join(appOutDir, 'resources', 'standalone', 'node_modules');
    const sourceNextServerRuntime = path.join(__dirname, 'node_modules', 'next', 'dist', 'compiled', 'next-server');
    const targetNextServerRuntime = path.join(targetNodeModules, 'next', 'dist', 'compiled', 'next-server');

    console.log(`[afterPack] Copying node_modules from ${standaloneNodeModules}`);
    console.log(`[afterPack] To ${targetNodeModules}`);

    if (!fs.existsSync(standaloneNodeModules)) {
        throw new Error('Standalone node_modules not found.');
    }

    copyDirSync(standaloneNodeModules, targetNodeModules);
    console.log('[afterPack] node_modules copied successfully');

    if (fs.existsSync(sourceNextServerRuntime)) {
        console.log(`[afterPack] Ensuring Next.js route runtimes from ${sourceNextServerRuntime}`);
        copyDirSync(sourceNextServerRuntime, targetNextServerRuntime);
        console.log('[afterPack] Next.js route runtimes copied successfully');
    } else {
        console.warn(`[afterPack] WARNING: Next.js route runtime dir not found: ${sourceNextServerRuntime}`);
    }

    prepareStandaloneMetadata(path.join(appOutDir, 'resources', 'standalone'));
    console.log('[afterPack] Standalone metadata prepared for the installation directory');
};
