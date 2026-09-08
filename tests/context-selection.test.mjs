import test from 'node:test';
import assert from 'node:assert/strict';
import { getChapterReferenceGroups, groupContextItems, getSelectedContextChapterIds, isContextItemSelected, toggleContextReferences, reconcileContextSelection } from '../app/lib/context-selection.js';

const text = (zh, en) => en;
const chapters = [{ id: 'intro' }, { id: 'v1', type: 'volume', title: 'Same title' }, { id: 'a' }, { id: 'b' }, { id: 'v2', type: 'volume', title: 'Same title' }, { id: 'c' }, { id: 'd' }];
const groups = getChapterReferenceGroups(chapters, text);
const items = chapters.filter(ch => ch.type !== 'volume').map(ch => ({ id: `chapter-${ch.id}`, name: ch.id, ...groups.get(ch.id) }));
const summary = { id: 'summary-cross', name: 'Cross-volume synopsis', groupId: 'chapter-summaries', _chapterIds: ['a', 'b', 'c'], enabled: true };
const other = [{ id: 'setting-one', name: 'Setting', group: 'Settings', enabled: true }, { id: 'dialogue-one', name: 'Chat', group: 'Chat' }];
const allItems = [...items, summary, ...other];
const inVolume = id => items.filter(item => item._volumeId === id);

test('ordered volume separators group chapters without merging same-named volumes', () => {
    assert.equal(groups.get('intro').group, 'Unfiled chapters');
    assert.equal(groups.get('b').groupId, 'volume:v1');
    assert.equal(groups.get('c').groupId, 'volume:v2');
    assert.equal(groups.get('v1'), undefined);
    assert.deepEqual(Object.keys(groupContextItems(items)), ['chapters-unfiled', 'volume:v1', 'volume:v2']);
});

test('unvolumed books keep a flat chapter group and empty volumes create no reference items', () => {
    const noVolumes = getChapterReferenceGroups([{ id: 'a' }, { id: 'b' }], text);
    assert.equal(noVolumes.get('b').group, 'Chapters');
    assert.equal(noVolumes.get('b').groupId, 'chapters');
    assert.equal(getChapterReferenceGroups([{ id: 'v', type: 'volume' }], text).size, 0);
});

test('a volume checkbox selects and clears only its chapters while retaining unrelated references', () => {
    const before = new Set(['setting-one', 'dialogue-one', 'chapter-c']);
    const selected = toggleContextReferences(before, inVolume('v1'), allItems);
    assert.deepEqual(selected, new Set([...before, 'chapter-a', 'chapter-b']));
    assert.deepEqual(toggleContextReferences(selected, inVolume('v1'), allItems), before);
    assert.deepEqual(before, new Set(['setting-one', 'dialogue-one', 'chapter-c']));
});

test('clearing a volume removes overlapping synopsis coverage and preserves outside chapters', () => {
    const before = new Set(['summary-cross', 'setting-one', 'dialogue-one']);
    const coverage = getSelectedContextChapterIds(allItems, before);
    assert.equal(isContextItemSelected(items.find(it => it._chapterId === 'a'), before, coverage), true);
    const after = toggleContextReferences(before, inVolume('v1'), allItems);
    assert.deepEqual(after, new Set(['chapter-c', 'setting-one', 'dialogue-one']));
    assert.deepEqual(getSelectedContextChapterIds(allItems, after), new Set(['c']));
});

test('clearing one summary-covered chapter keeps the rest selected, including overlapping summaries', () => {
    const overlapping = [...allItems, { id: 'summary-other', _chapterIds: ['b', 'd'] }];
    const after = toggleContextReferences(new Set(['summary-cross', 'summary-other']), [items.find(it => it._chapterId === 'b')], overlapping);
    assert.deepEqual(after, new Set(['chapter-a', 'chapter-c', 'chapter-d']));
});

test('partial volume selection becomes full selection and search can match a volume title', () => {
    const after = toggleContextReferences(new Set(['chapter-a']), inVolume('v1'), allItems);
    assert.deepEqual(after, new Set(['chapter-a', 'chapter-b']));
    assert.deepEqual(Object.keys(groupContextItems(items, ' SAME TITLE ')), ['volume:v1', 'volume:v2']);
    assert.deepEqual(groupContextItems([{ id: 'empty', _empty: true }]), Object.create(null));
});

test('explicitly clearing all references stays cleared on refresh; only an explicit reset restores defaults', () => {
    assert.deepEqual(reconcileContextSelection(new Set(), allItems), new Set());
    assert.deepEqual(reconcileContextSelection(new Set(['removed-id']), allItems), new Set());
    assert.deepEqual(reconcileContextSelection(new Set(), allItems, true), new Set(['summary-cross', 'setting-one']));
});

test('invalidated cached synopses retain selection as clean chapter references', () => {
    const after = reconcileContextSelection(new Set(['summary-cross', 'setting-one']), [...items, ...other], false, allItems);
    assert.deepEqual(after, new Set(['setting-one', 'chapter-a', 'chapter-b', 'chapter-c']));
    assert.deepEqual(reconcileContextSelection(new Set(), [...items, ...other], false, allItems), new Set());
});
