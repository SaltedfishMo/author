import test from 'node:test';
import assert from 'node:assert/strict';
import { filterStrikethroughHtml, prepareChapterForAi, prepareChaptersForAi, filterMemoryGroupsForAi } from '../app/lib/ai-reference-content.js';
import { hasChapterSynopsis } from '../app/lib/chapter-synopsis.js';

test('outbound HTML excludes nested strike marks while preserving surrounding formatting and breaks', () => {
    assert.equal(filterStrikethroughHtml('<p>A<strong><s>old <em>nested</em><br>text</s>B</strong><br>C</p><p><STRIKE>old</STRIKE><del>old</del>D</p>'), '<p>A<strong>B</strong><br>C</p><p>D</p>');
});

test('inline decoration styles are excluded, other styles and attributes remain intact', () => {
    const html = '<p><span style="color:red; text-decoration: underline line-through !important">old</span><span STYLE=TEXT-DECORATION-LINE:line-through>old</span><span style="text-decoration:underline">kept</span><span title=\' style="text-decoration:line-through"\'>literal</span></p>';
    assert.equal(filterStrikethroughHtml(html), '<p><span style="text-decoration:underline">kept</span><span title=\' style="text-decoration:line-through"\'>literal</span></p>');
});

test('escaped tags, comments, quoted angle brackets, and struck void nodes do not consume adjacent text', () => {
    const html = '<p>&lt;s&gt;literal&lt;/s&gt;<!-- <s>example</s> --><s title="a > b">old<img src="fixture"></s>kept<br style="text-decoration:line-through">end</p>';
    assert.equal(filterStrikethroughHtml(html), '<p>&lt;s&gt;literal&lt;/s&gt;<!-- <s>example</s> -->keptend</p>');
});

test('the default preserves existing text, cached synopses, and object identity', () => {
    const chapter = { id: 'chapter-a', content: '<p>kept<s>old</s></p>', synopsis: { summary: 'old synopsis' } };
    const chapters = [chapter];
    assert.equal(prepareChapterForAi(chapter), chapter);
    assert.equal(prepareChaptersForAi(chapters), chapters);
    assert.equal(hasChapterSynopsis(prepareChapterForAi(chapter)), true);
});

test('filtering invalidates stale synopses only on the outbound copy, never the stored chapter', () => {
    const chapter = { id: 'chapter-a', title: 'A', content: '<p>kept<s>old</s></p>', synopsis: { summary: 'old synopsis', locked: true }, chapterSynopsis: 'legacy', summary: 'legacy' };
    const original = structuredClone(chapter);
    const clean = prepareChapterForAi(chapter, true);
    assert.equal(clean.content, '<p>kept</p>');
    assert.equal(hasChapterSynopsis(clean), false);
    assert.deepEqual(chapter, original);
    assert.equal(prepareChapterForAi({ type: 'volume', title: 'Volume' }, true).title, 'Volume');
    const unchanged = { id: 'chapter-b', content: '<p>kept</p>', synopsis: { summary: 'valid synopsis' } };
    assert.equal(prepareChapterForAi(unchanged, true), unchanged);
});

test('only cached memory groups covering filtered chapters are bypassed', () => {
    const chapters = [{ id: 'a', content: '<s>old</s>kept' }, { id: 'b', content: 'untouched' }];
    const groups = [{ id: 'cross', chapterIds: ['a', 'b'], summary: 'old' }, { id: 'safe', chapterIds: ['b'], summary: 'valid' }];
    assert.deepEqual(filterMemoryGroupsForAi(groups, chapters), groups);
    assert.deepEqual(filterMemoryGroupsForAi(groups, prepareChaptersForAi(chapters, true)), [groups[1]]);
    assert.equal(groups[0].summary, 'old');
});
