import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { git, repositoryFiles } from './repository-files.mjs';
import { installGitleaks, installArtifactConfig, pin } from './security/gitleaks.mjs';
import { expectedNextRuntimeKey } from './security/artifact-policy.mjs';
import { snapshotArtifact, writeArtifactConfig } from './security/artifact-snapshot.mjs';
import { createDependencyReviewer } from './security/reviewed-dependencies.mjs';
import { pruneOlderScans } from './security/scan-retention.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');

export function snapshotSource(root, destination) {
    const files = [];
    for (const file of repositoryFiles(root)) {
        const source = path.resolve(root, file);
        if (!source.startsWith(`${root}${path.sep}`)) throw new Error('Source path leaves the repository.');
        let stat;
        try { stat = lstatSync(source); } catch (error) {
            if (error.code === 'ENOENT') continue; // Tracked file deleted in the working tree.
            throw error;
        }
        if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`Unsupported source entry: ${file}`);
        const target = path.join(destination, file);
        mkdirSync(path.dirname(target), { recursive: true });
        // Scan the link text, as Git stores it, without reading outside the tree.
        if (stat.isSymbolicLink()) writeFileSync(target, readlinkSync(source), { flag: 'wx' });
        else {
            if (!realpathSync(source).startsWith(`${realpathSync(root)}${path.sep}`)) throw new Error(`Source resolves outside repository: ${file}`);
            copyFileSync(source, target);
        }
        files.push(file);
    }
    return files;
}

export function scanWithGitleaks(executable, { mode, target, reportDirectory, configRoot = projectRoot }) {
    mkdirSync(reportDirectory, { recursive: true });
    const findingsPath = path.join(reportDirectory, 'findings.json');
    const ignores = path.join(reportDirectory, 'empty.gitleaksignore');
    writeFileSync(ignores, '', { flag: 'wx' });
    const config = mode === 'artifact' ? writeArtifactConfig(configRoot, reportDirectory) : path.join(configRoot, '.gitleaks.toml');
    const args = [mode === 'history' ? 'git' : 'dir', target,
        '--config', config, '--no-banner', '--no-color', '--redact=100',
        '--ignore-gitleaks-allow', '--gitleaks-ignore-path', ignores,
        '--report-format', 'template', '--report-template', path.join(projectRoot, 'scripts/security/report-template.tmpl'),
        '--report-path', findingsPath, '--exit-code', '42', '--log-level', 'error',
        '--max-archive-depth', '2', '--max-decode-depth', '2', '--timeout', '300'];
    if (mode === 'history') args.push('--log-opts=--all --full-history -m');
    const env = { ...process.env };
    const configCount = Number(env.GIT_CONFIG_COUNT || 0);
    env.GIT_CONFIG_COUNT = String(configCount + 1);
    env[`GIT_CONFIG_KEY_${configCount}`] = 'safe.directory';
    env[`GIT_CONFIG_VALUE_${configCount}`] = target;
    const result = spawnSync(executable, args, { cwd: projectRoot, env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 330_000, windowsHide: true });
    // Scanner output may contain sensitive context. Only our metadata template is retained/displayed.
    if (result.error || result.stderr?.trim() || ![0, 42].includes(result.status) || !existsSync(findingsPath)) {
        throw new Error(`Secret scanner failed (${result.error?.code || result.status}); this is NOT a clean scan.`);
    }
    const findings = JSON.parse(readFileSync(findingsPath, 'utf8'));
    if (!Array.isArray(findings) || (result.status === 42) !== (findings.length > 0)) throw new Error('Secret scanner returned an inconsistent report.');
    return findings;
}

export async function checkSecrets(mode, input, root = projectRoot, { alreadyExtractedFiles = [] } = {}) {
    if (!['tree', 'history', 'artifact'].includes(mode)) throw new Error('Usage: node scripts/check-secrets.mjs tree|history|artifact [artifact-directory]');
    if (mode === 'artifact' && (!input || !lstatSync(path.resolve(input)).isDirectory())) throw new Error('Artifact scan requires an existing, unpacked directory.');
    const shallow = mode === 'history' && git(root, ['rev-parse', '--is-shallow-repository']).trim() === 'true';
    if (shallow) throw new Error('History scan requires a full checkout (fetch-depth: 0); a shallow scan cannot pass.');
    const executable = await installGitleaks(projectRoot);
    if (mode === 'artifact') await installArtifactConfig(projectRoot);
    const reportsRoot = path.join(root, '.tmp', 'secret-scans');
    mkdirSync(reportsRoot, { recursive: true });
    const reportDirectory = mkdtempSync(path.join(reportsRoot, `${mode}-`));
    let target = mode === 'artifact' ? path.resolve(input) : root;
    const scope = { mode };
    let artifactFiles;
    if (mode === 'tree') {
        target = path.join(reportDirectory, 'source');
        mkdirSync(target);
        const files = snapshotSource(root, target);
        scope.files = files.length;
        writeFileSync(path.join(reportDirectory, 'source-files.json'), `${JSON.stringify(files, null, 2)}\n`);
    } else if (mode === 'history') {
        scope.commits = Number(git(root, ['rev-list', '--all', '--count']).trim());
        scope.refs = git(root, ['for-each-ref', '--format=%(refname)']).trim().split('\n').filter(Boolean);
    } else {
        scope.directory = target;
        scope.alreadyExtractedFiles = alreadyExtractedFiles;
        target = path.join(reportDirectory, 'artifact');
        artifactFiles = snapshotArtifact(scope.directory, target, alreadyExtractedFiles);
        scope.files = artifactFiles.length;
        scope.renamedFiles = artifactFiles.filter(file => path.relative(scope.directory, file.source) !== path.relative(target, file.snapshot)).length;
        writeFileSync(path.join(reportDirectory, 'artifact-files.json'), `${JSON.stringify(artifactFiles, null, 2)}\n`);
    }
    const findings = scanWithGitleaks(executable, { mode, target, reportDirectory });
    const expectedRuntimeKeys = mode === 'artifact' ? findings.filter(finding => expectedNextRuntimeKey(finding, target)) : [];
    const reviewDependency = artifactFiles ? createDependencyReviewer(artifactFiles) : () => false;
    const reviewedReasons = new Map(findings.map(finding => [finding, reviewDependency(finding)]).filter(([, reason]) => reason));
    const blockingFindings = findings.filter(finding => !expectedRuntimeKeys.includes(finding) && !reviewedReasons.has(finding));
    if (artifactFiles) {
        const originalPaths = new Map(artifactFiles.map(file => [path.resolve(file.snapshot), file.source]));
        for (const finding of findings) {
            const separator = finding.file.indexOf('!');
            const outer = separator < 0 ? finding.file : finding.file.slice(0, separator);
            const suffix = separator < 0 ? '' : finding.file.slice(separator);
            const original = originalPaths.get(path.resolve(outer));
            if (!original) throw new Error('Scanner finding is outside the artifact snapshot.');
            finding.file = original.replaceAll('\\', '/') + suffix;
        }
    }
    const reviewedDependencyFindings = [...reviewedReasons].map(([finding, reason]) => ({ ...finding, reason }));
    const report = { scanner: `gitleaks ${pin.version}`, scope, status: blockingFindings.length ? 'findings' : 'passed', findings, expectedRuntimeKeys, reviewedDependencyFindings, blockingFindings };
    writeFileSync(path.join(reportDirectory, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Secret scan (${mode}): ${blockingFindings.length} blocking finding(s), ${expectedRuntimeKeys.length} expected Next.js runtime key(s), ${reviewedDependencyFindings.length} reviewed dependency finding(s). Metadata report: ${path.join(reportDirectory, 'summary.json')}`);
    for (const finding of blockingFindings) {
        // Report locations only; never print the matched value or surrounding text.
        console.log(JSON.stringify({ rule: finding.rule, file: path.relative(mode === 'artifact' ? scope.directory : target, finding.file).replaceAll('\\', '/'), line: finding.line, column: finding.column }));
    }
    pruneOlderScans(reportsRoot, [reportDirectory, mode === 'artifact' ? scope.directory : undefined]);
    return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    try {
        const report = await checkSecrets(process.argv[2], process.argv[3]);
        if (report.blockingFindings.length) process.exitCode = 1;
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
