import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { extractAll } from '@electron/asar';
import { checkSecrets } from './check-secrets.mjs';
import { pruneOlderScans } from './security/scan-retention.mjs';

try {
    if (!process.argv[2]) throw new Error('Usage: node scripts/check-electron-secrets.mjs UNPACKED_APP_DIRECTORY');
    const resources = path.resolve(process.argv[2], 'resources');
    const archive = path.join(resources, 'app.asar');
    if (!existsSync(archive) || !existsSync(path.join(resources, 'standalone/server.js'))) throw new Error('Packaged app.asar or standalone/server.js is missing.');
    const root = path.resolve('.tmp/secret-scans');
    mkdirSync(root, { recursive: true });
    const extracted = mkdtempSync(path.join(root, 'electron-asar-'));
    // ASAR is not a ZIP/TAR: explicitly unpack our newly built app before scanning.
    extractAll(archive, extracted);
    const main = await checkSecrets('artifact', extracted);
    // The exact ASAR file has already been unpacked and scanned above.
    const runtime = await checkSecrets('artifact', resources, undefined, { alreadyExtractedFiles: [archive] });
    pruneOlderScans(root, [extracted]);
    if (main.blockingFindings.length || runtime.blockingFindings.length) process.exitCode = 1;
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
