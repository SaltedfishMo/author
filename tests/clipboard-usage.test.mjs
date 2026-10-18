import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// 桌面端拒绝网页的所有权限请求（含剪贴板写入），直接调用 navigator.clipboard.writeText
// 会静默失败。界面里的复制统一走 app/lib/clipboard.js，被拒时它会退回 execCommand。
test('components copy text through the clipboard helper', () => {
    const dir = fileURLToPath(new URL('../app/components/', import.meta.url));
    const offenders = readdirSync(dir, { recursive: true })
        .filter(name => /\.(js|jsx|mjs)$/.test(name))
        .filter(name => /navigator\.clipboard\s*\??\.\s*writeText/.test(readFileSync(path.join(dir, name), 'utf8')));
    assert.deepEqual(offenders, []);
});
