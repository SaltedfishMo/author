import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { checkSecrets } from './check-secrets.mjs';
import { pruneOlderScans } from './security/scan-retention.mjs';

function docker(args) {
    const result = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120_000, windowsHide: true });
    if (result.error || result.status !== 0) throw new Error(`Docker ${args[0]} failed (${result.error?.code || result.status}).`);
    return result.stdout;
}

try {
    const image = process.argv[2];
    if (!image || image.startsWith('-')) throw new Error('Usage: node scripts/check-docker-secrets.mjs IMAGE');
    const inspected = JSON.parse(docker(['image', 'inspect', image]))[0];
    const root = path.resolve('.tmp/secret-scans');
    mkdirSync(root, { recursive: true });
    const exported = mkdtempSync(path.join(root, 'docker-'));
    const name = `author-secret-scan-${Date.now()}-${process.pid}`;
    // Create without starting: no application runs and no host folder is mounted.
    docker(['create', '--name', name, '--network', 'none', inspected.Id]);
    const app = path.join(exported, 'app');
    mkdirSync(app);
    docker(['cp', `${name}:/app/.`, app]);
    writeFileSync(path.join(exported, 'image-config.json'), `${JSON.stringify(inspected.Config, null, 2)}\n`);
    writeFileSync(path.join(exported, 'scope.json'), `${JSON.stringify({ image: inspected.Id, container: name, paths: ['/app', 'image.Config'], excludes: ['base OS filesystem', 'deleted files in older image layers'] }, null, 2)}\n`);
    const report = await checkSecrets('artifact', exported);
    console.log(`Docker application scan: ${inspected.Id}; unstarted inspection container retained: ${name}`);
    pruneOlderScans(root, [exported]);
    if (report.blockingFindings.length) process.exitCode = 1;
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
