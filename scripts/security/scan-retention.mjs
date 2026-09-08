import { readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

// Every scan directory is created with mkdtempSync, which appends exactly six random characters.
const scanDirectory = /^(tree|history|artifact|docker|electron-asar)-[A-Za-z0-9]{6}$/;

export const retainedScans = 3;

// Scans leave behind unpacked artifacts that are hundreds of megabytes each, so old runs are dropped
// per scan type: keeping a fixed count overall would let frequent artifact runs evict the rare history run.
export function pruneScanDirectories(scansRoot, { keep = retainedScans, protect = [] } = {}) {
    let entries;
    try { entries = readdirSync(scansRoot, { withFileTypes: true }); } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
    const protected_ = new Set(protect.filter(Boolean).map(entry => path.resolve(entry)));
    const groups = new Map();
    for (const entry of entries) {
        const match = scanDirectory.exec(entry.name);
        // Anything this pipeline did not create is left alone, as is a symlink pointing outside the tree.
        if (!match || !entry.isDirectory()) continue;
        const directory = path.join(scansRoot, entry.name);
        let modified;
        try { modified = statSync(directory).mtimeMs; } catch (error) {
            if (error.code === 'ENOENT') continue; // Removed by a concurrent run.
            throw error;
        }
        const group = groups.get(match[1]) || [];
        group.push({ directory, modified });
        groups.set(match[1], group);
    }
    const removed = [];
    for (const group of groups.values()) {
        group.sort((a, b) => b.modified - a.modified);
        for (const { directory } of group.slice(keep)) {
            if (protected_.has(path.resolve(directory))) continue; // The run in progress is never a candidate.
            rmSync(directory, { recursive: true, force: true });
            removed.push(directory);
        }
    }
    return removed;
}

// Housekeeping must never fail a scan or mask its result, so callers use this reporting wrapper.
export function pruneOlderScans(scansRoot, protect = []) {
    try {
        const removed = pruneScanDirectories(scansRoot, { protect });
        if (removed.length) console.log(`Secret scan cleanup: removed ${removed.length} older scan directory(ies); the ${retainedScans} most recent of each scan type are kept.`);
    } catch (error) {
        console.warn(`Secret scan cleanup skipped: ${error.message}`);
    }
}
