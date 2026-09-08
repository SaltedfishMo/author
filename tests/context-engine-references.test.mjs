import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { getContextGroupId, groupContextItems, reconcileContextSelection, toggleContextReferences } from '../app/lib/context-selection.js';

let fixtureId = 0;
async function fixture(t, { exclude = false, memory = false, embed = false } = {}) {
    const id = ++fixtureId;
    const base = new URL('../app/lib/', import.meta.url);
    const chapters = [
        { id: 'v1', type: 'volume', title: 'Volume One' },
        ...['a', 'b'].map(id => ({ id, title: id, content: `<p>VISIBLE_${id} <s>OMITTED_${id}</s> END_${id}</p>`, synopsis: { summary: `OMITTED_${id} cached synopsis` } })),
        { id: 'v2', type: 'volume', title: 'Volume Two' },
        ...['c', 'd', 'e'].map(id => ({ id, title: id, content: `<p>VISIBLE_${id} <span style="text-decoration:line-through">OMITTED_${id}</span> END_${id}</p>` })),
        { id: 'v3', type: 'volume', title: 'Volume Three' },
        { id: 'f', title: 'f', content: '<p>VISIBLE_f <del>OMITTED_f</del> END_f</p>' },
    ];
    const data = {
        chapters, settings: { apiConfig: { excludeStrikethroughFromAi: exclude, useCustomEmbed: embed } },
        memoryGroups: memory ? [{ id: 'cross', name: 'Cross-volume recap', chapterIds: ['a', 'b', 'c', 'd'], summary: 'OMITTED_GROUP cached synopsis' }] : [],
        nodes: embed ? [{ id: 'fixture-character', type: 'item', category: 'character', name: 'Fixture Character', enabled: true, embedding: [1, 0], content: { description: 'Fixture description' } }] : [],
        embeddingQueries: [],
    };
    const dataUrl = `data:text/javascript,${encodeURIComponent(`export const data = ${JSON.stringify(data)};`)}#reference-fixture-${id}`;
    const moduleUrl = source => `data:text/javascript,${encodeURIComponent(`import { data } from ${JSON.stringify(dataUrl)};\n${source}`)}`;
    const stubs = {
        './storage': moduleUrl('export const getChapters = async () => data.chapters;'),
        './settings': moduleUrl('export const getProjectSettings = () => data.settings; export const getSettingsNodes = async () => data.nodes; export const getActiveWorkId = () => "fixture-work"; export const getWritingMode = () => "novel";'),
        './embeddings': moduleUrl('export const getEmbedding = async query => { data.embeddingQueries.push(query); return [1, 0]; }; export const cosineSimilarity = () => 1;'),
        './persistence': moduleUrl('export const persistGet = async () => data.memoryGroups; export const persistSet = async () => { throw new Error("Unexpected persistent write"); };'),
    };
    const globals = { window: {}, localStorage: { getItem: key => key === 'author-lang' ? 'en' : null } };
    for (const [key, value] of Object.entries(globals)) {
        const original = Object.getOwnPropertyDescriptor(globalThis, key);
        Object.defineProperty(globalThis, key, { configurable: true, value });
        t.after(() => original ? Object.defineProperty(globalThis, key, original) : delete globalThis[key]);
    }
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network request'); });
    const hook = registerHooks({ resolve(specifier, context, nextResolve) {
        if (context.parentURL?.startsWith(base.href)) {
            if (stubs[specifier]) return { url: stubs[specifier], shortCircuit: true };
            if (specifier.startsWith('./')) {
                const url = new URL(specifier.endsWith('.js') ? specifier : `${specifier}.js`, context.parentURL);
                url.searchParams.set('referenceFixture', String(id));
                return nextResolve(url.href, context);
            }
        }
        return nextResolve(specifier, context);
    } });
    try {
        const engine = await import(new URL(`context-engine.js?referenceFixture=${id}`, base));
        const { data: state } = await import(dataUrl);
        return { engine, state };
    } finally { hook.deregister(); }
}

test('actual reference items preserve chapter order, IDs, and default coverage under volume headings', async t => {
    const { engine } = await fixture(t);
    const items = await engine.getContextItems('f');
    const leaves = items.filter(item => item._chapterId);
    assert.deepEqual(leaves.map(item => item._chapterId), ['a', 'b', 'c', 'd', 'e', 'f']);
    assert.deepEqual(leaves.map(item => item.id), ['chapter-a', 'chapter-b', 'chapter-c', 'chapter-d', 'chapter-previous-anchor', 'chapter-current']);
    assert.deepEqual(Object.keys(groupContextItems(leaves)), ['volume:v1', 'volume:v2', 'volume:v3']);
    const selection = reconcileContextSelection(new Set(), items, true);
    const context = await engine.buildContext('f', '', selection);
    assert.match(context.currentChapter, /OMITTED_f/);
    assert.match(context.previousChapterAnchor, /OMITTED_e/);
    assert.match(context.previousChapters, /OMITTED_a cached synopsis/);
});

test('enabled filtering reaches final AI prompts and bypasses stale chapter and multi-chapter synopses', async t => {
    const { engine, state } = await fixture(t, { memory: true });
    const stored = structuredClone(state);
    const original = await engine.buildContext('f', 'question');
    assert.match(engine.compileSystemPrompt(original, 'chat'), /OMITTED_GROUP/);
    state.settings.apiConfig.excludeStrikethroughFromAi = true;
    const clean = await engine.buildContext('f', 'question');
    const prompt = engine.compileSystemPrompt(clean, 'chat');
    assert.doesNotMatch(prompt, /OMITTED_/);
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) assert.match(prompt, new RegExp(`VISIBLE_${id}`));
    assert.deepEqual(state.chapters, stored.chapters);
    assert.deepEqual(state.memoryGroups, stored.memoryGroups);
});

test('enabling filtering retains selected chapters when their cached summary becomes unavailable', async t => {
    const { engine, state } = await fixture(t, { memory: true });
    const beforeItems = await engine.getContextItems('f');
    const before = reconcileContextSelection(new Set(), beforeItems, true);
    assert.ok(before.has('memory-group-cross'));
    state.settings.apiConfig.excludeStrikethroughFromAi = true;
    const items = await engine.getContextItems('f');
    const selection = reconcileContextSelection(before, items, false, beforeItems);
    const context = await engine.buildContext('f', '', selection);
    assert.doesNotMatch(JSON.stringify(context), /OMITTED_/);
    for (const id of ['a', 'b', 'c', 'd']) assert.match(context.previousChapters, new RegExp(`VISIBLE_${id}`));
});

for (const memory of [false, true]) {
    test(`clearing an entire volume excludes its previous chapter and ${memory ? 'custom' : 'automatic'} cross-volume synopsis`, async t => {
        const { engine } = await fixture(t, { memory });
        const items = await engine.getContextItems('f');
        const defaults = reconcileContextSelection(new Set(), items, true);
        const targets = items.filter(item => getContextGroupId(item) === 'volume:v2');
        const selection = toggleContextReferences(defaults, targets, items);
        const context = await engine.buildContext('f', '', selection);
        assert.equal(context.previousChapterAnchor, '');
        assert.doesNotMatch(JSON.stringify(context), /VISIBLE_[cde]|OMITTED_[cde]|OMITTED_GROUP/);
        assert.match(context.previousChapters, /OMITTED_a/);
        assert.match(context.previousChapters, /OMITTED_b/);
        assert.match(context.currentChapter, /VISIBLE_f/);
    });
}

test('an explicit empty selection sends no chapter text and makes no automatic embedding request', async t => {
    const { engine, state } = await fixture(t, { embed: true });
    const context = await engine.buildContext('f', 'question', new Set());
    assert.equal(context.currentChapter, '');
    assert.equal(context.previousChapterAnchor, '');
    assert.equal(context.previousChapters, '');
    assert.equal(context.characters, '');
    assert.deepEqual(state.embeddingQueries, []);
});

test('automatic embedding enrichment respects both strike filtering and current-chapter selection', async t => {
    const { engine, state } = await fixture(t, { exclude: true, embed: true });
    await engine.buildContext('f', 'question', new Set(['chapter-current']));
    assert.match(state.embeddingQueries[0], /VISIBLE_f/);
    assert.doesNotMatch(state.embeddingQueries[0], /OMITTED_f/);
    await engine.buildContext('f', 'question', new Set(['chapter-a']));
    assert.equal(state.embeddingQueries[1], 'question');
});
