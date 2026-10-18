import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getDefaultFirstChapterRetitle, isBlankChapterContent } from '../app/lib/first-chapter-title.js';

const titleFor = (lang) => JSON.parse(
    readFileSync(new URL(`../app/locales/${lang}.json`, import.meta.url), 'utf8'),
).page.firstChapterTitle;

const zh = titleFor('zh');
const en = titleFor('en');
const ru = titleFor('ru');
const defaultTitles = [zh, en, ru];

function autoChapter(overrides = {}) {
    return {
        id: 'ch-1',
        title: zh,
        content: '',
        wordCount: 0,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        ...overrides,
    };
}

test('each locale has its own non-empty default first chapter title', () => {
    for (const title of defaultTitles) assert.ok(typeof title === 'string' && title.trim());
    assert.equal(new Set(defaultTitles).size, defaultTitles.length);
});

test('renames the untouched auto-created chapter to the chosen language', () => {
    assert.deepEqual(getDefaultFirstChapterRetitle([autoChapter()], { defaultTitles, nextTitle: en }), { id: 'ch-1', title: en });
    assert.deepEqual(getDefaultFirstChapterRetitle([autoChapter()], { defaultTitles, nextTitle: ru }), { id: 'ch-1', title: ru });
    assert.deepEqual(getDefaultFirstChapterRetitle([autoChapter({ title: en })], { defaultTitles, nextTitle: zh }), { id: 'ch-1', title: zh });
});

test('does nothing when the title already matches the chosen language', () => {
    assert.equal(getDefaultFirstChapterRetitle([autoChapter()], { defaultTitles, nextTitle: zh }), null);
    assert.equal(getDefaultFirstChapterRetitle([autoChapter({ title: en })], { defaultTitles, nextTitle: en }), null);
});

test('keeps titles the author changed', () => {
    for (const title of ['序章', 'Prologue', `${zh} `, '']) {
        assert.equal(getDefaultFirstChapterRetitle([autoChapter({ title })], { defaultTitles, nextTitle: en }), null);
    }
});

test('keeps chapters that already have text, word count or a synopsis', () => {
    const touched = [
        { content: '<p>开头</p>', wordCount: 2 },
        { content: '<p>Once</p>' },
        { wordCount: 3 },
        { content: '<p><img src="cover.png"></p>' },
        { content: '<hr>' },
        { synopsis: 'Plot notes' },
        { chapterSynopsis: { text: 'Plot notes' } },
        { summary: 'Plot notes' },
        { content: { type: 'doc' } },
    ];
    for (const overrides of touched) {
        assert.equal(getDefaultFirstChapterRetitle([autoChapter(overrides)], { defaultTitles, nextTitle: en }), null, JSON.stringify(overrides));
    }
});

test('treats the editor empty-document markup as blank', () => {
    for (const content of [undefined, null, '', '   ', '<p></p>', '<p><br></p>', '<p><br/></p>', '<p>&nbsp;</p>', '<p></p><p></p>']) {
        assert.equal(isBlankChapterContent(content), true, String(content));
        assert.deepEqual(getDefaultFirstChapterRetitle([autoChapter({ content })], { defaultTitles, nextTitle: en }), { id: 'ch-1', title: en });
    }
    assert.equal(isBlankChapterContent('<p>a</p>'), false);
});

test('only applies when the work holds exactly that one chapter', () => {
    const second = autoChapter({ id: 'ch-2', title: '第二章' });
    assert.equal(getDefaultFirstChapterRetitle([autoChapter(), second], { defaultTitles, nextTitle: en }), null);
    assert.equal(getDefaultFirstChapterRetitle([autoChapter({ type: 'volume' })], { defaultTitles, nextTitle: en }), null);
    assert.equal(getDefaultFirstChapterRetitle([], { defaultTitles, nextTitle: en }), null);
    assert.equal(getDefaultFirstChapterRetitle(null, { defaultTitles, nextTitle: en }), null);
    assert.equal(getDefaultFirstChapterRetitle([autoChapter()], { defaultTitles, nextTitle: '' }), null);
});
