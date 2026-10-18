import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const LANGS = ['zh', 'en', 'ru'];
const CJK = /[㐀-鿿豈-﫿]/;

const locales = Object.fromEntries(LANGS.map(lang => [
    lang,
    JSON.parse(readFileSync(path.join(root, 'app', 'locales', `${lang}.json`), 'utf8')),
]));

function flatten(value, prefix = '', out = {}) {
    for (const [key, child] of Object.entries(value)) {
        const fullKey = prefix ? `${prefix}.${key}` : key;
        if (child && typeof child === 'object') flatten(child, fullKey, out);
        else out[fullKey] = child;
    }
    return out;
}

const flat = Object.fromEntries(LANGS.map(lang => [lang, flatten(locales[lang])]));

function placeholders(value) {
    return [...String(value).matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
}

function sourceFiles(dir) {
    const files = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) files.push(...sourceFiles(full));
        else if (/\.(?:[cm]?js|jsx)$/.test(entry.name)) files.push(full);
    }
    return files;
}

const sources = sourceFiles(path.join(root, 'app')).map(file => ({
    file: path.relative(root, file).replaceAll(path.sep, '/'),
    code: readFileSync(file, 'utf8'),
}));

test('zh, en and ru locale files define the same keys', () => {
    const zhKeys = Object.keys(flat.zh).sort();
    for (const lang of ['en', 'ru']) {
        assert.deepEqual(Object.keys(flat[lang]).sort(), zhKeys, `${lang}.json keys differ from zh.json`);
    }
});

test('en and ru translations contain no Chinese text', () => {
    for (const lang of ['en', 'ru']) {
        const untranslated = Object.entries(flat[lang]).filter(([, value]) => CJK.test(String(value)));
        assert.deepEqual(untranslated, [], `${lang}.json still has Chinese values`);
    }
});

test('every translation uses the same {placeholders} in all languages', () => {
    for (const [key, zhValue] of Object.entries(flat.zh)) {
        for (const lang of ['en', 'ru']) {
            assert.deepEqual(placeholders(flat[lang][key]), placeholders(zhValue), `${lang}: ${key}`);
        }
    }
});

test('translation keys referenced in app code exist in every language', () => {
    const missing = [];
    const keyPattern = /(?<![\w$])t\(\s*(['"])([A-Za-z]\w*(?:\.\w+)+)\1|labelKey:\s*(['"])([A-Za-z]\w*(?:\.\w+)+)\3/g;
    for (const { file, code } of sources) {
        for (const match of code.matchAll(keyPattern)) {
            const key = match[2] || match[4];
            for (const lang of LANGS) {
                if (typeof flat[lang][key] !== 'string') missing.push(`${file}: ${key} (${lang})`);
            }
        }
    }
    assert.deepEqual(missing, []);
});

test('intentionally empty translations are not replaced by a hard-coded fallback', () => {
    const emptyKeys = new Set(LANGS.flatMap(lang => Object.entries(flat[lang])
        .filter(([, value]) => value === '')
        .map(([key]) => key)));
    const offenders = [];
    const fallbackPattern = /(?<![\w$])t\(\s*(['"])([\w.]+)\1\s*(?:,[^()]*)?\)\s*\|\|/g;
    for (const { file, code } of sources) {
        for (const match of code.matchAll(fallbackPattern)) {
            if (emptyKeys.has(match[2])) offenders.push(`${file}: ${match[2]}`);
        }
    }
    assert.deepEqual(offenders, []);
});

test('every slash command label comes from the locale files', () => {
    const code = sources.find(source => source.file === 'app/components/SlashCommands.js').code;
    const block = code.slice(code.indexOf('const COMMANDS = ['), code.indexOf('];', code.indexOf('const COMMANDS = [')));
    const commands = [...block.matchAll(/\{\s*id:\s*'(\w+)',([^\n]*)/g)].map(match => ({ id: match[1], rest: match[2] }));

    assert.equal(commands.length, 9);
    assert.deepEqual(commands.map(command => command.id).sort(), Object.keys(locales.zh.slashCommands).sort());
    for (const { id, rest } of commands) {
        assert.match(rest, new RegExp(`labelKey:\\s*'slashCommands\\.${id}'`), `${id} should use slashCommands.${id}`);
        assert.doesNotMatch(rest, /\blabel:/, `${id} should not hard-code a label`);
        for (const lang of LANGS) {
            assert.ok(locales[lang].slashCommands[id]?.trim(), `${lang}: slashCommands.${id} is empty`);
        }
    }
});
