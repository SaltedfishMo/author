import test from 'node:test';
import assert from 'node:assert/strict';

import {
    getBuiltInFolderLabel,
    getBuiltInEndpointName,
    getBuiltInNodeLabel,
    getBuiltInWorkName,
    getSettingsIconOptions,
    isBuiltInFolderLabel,
} from '../app/lib/built-in-labels.js';

const pick = language => (zh, en, ru) => ({ zh, en, ru })[language];

test('root category labels translate from any stored language', () => {
    assert.equal(getBuiltInFolderLabel('Characters', pick('zh')), '人物设定');
    assert.equal(getBuiltInFolderLabel('人物设定', pick('en')), 'Characters');
    assert.equal(getBuiltInFolderLabel('Персонажи', pick('en')), 'Characters');
    assert.equal(getBuiltInFolderLabel('Items', pick('ru')), 'Предметы / реквизит');
});

test('pre-created subfolders translate in both directions', () => {
    assert.equal(getBuiltInFolderLabel('Main Characters', pick('ru')), 'Главные персонажи');
    assert.equal(getBuiltInFolderLabel('История / Эпохи', pick('zh')), '历史/纪元');
});

test('custom names remain unchanged', () => {
    assert.equal(getBuiltInFolderLabel('My secret society', pick('zh')), 'My secret society');
    assert.equal(isBuiltInFolderLabel('My secret society'), false);
    assert.equal(isBuiltInFolderLabel('Worldbuilding'), true);
});

test('default work names also translate from old localized storage', () => {
    assert.equal(getBuiltInWorkName('Default Work', pick('ru')), 'Работа по умолчанию');
    assert.equal(getBuiltInWorkName('Новое произведение', pick('zh')), '新作品');
});

test('node display translates built-in containers while preserving entry names and stored data', () => {
    const nodes = [
        { id: 'work', type: 'work', name: '默认作品' },
        { id: 'folder', type: 'folder', name: '主要角色' },
        { id: 'special', type: 'special', name: '作品信息' },
        { id: 'entry', type: 'item', name: '主要角色', content: { text: '用户正文' } },
        { id: 'custom', type: 'folder', name: 'My cast' },
    ];
    const stored = structuredClone(nodes);

    assert.deepEqual(nodes.map(node => getBuiltInNodeLabel(node, pick('en'))), [
        'Default Work', 'Main Characters', 'Book Info', '主要角色', 'My cast',
    ]);
    assert.deepEqual(nodes.map(node => getBuiltInNodeLabel(node, pick('ru'))), [
        'Работа по умолчанию', 'Главные персонажи', 'Информация о произведении', '主要角色', 'My cast',
    ]);
    assert.deepEqual(nodes.map(node => getBuiltInNodeLabel(node, pick('zh'))), stored.map(node => node.name));
    assert.deepEqual(nodes, stored);
});

test('changing icon label language preserves every persisted icon identifier', () => {
    const names = [
        'user', 'map-pin', 'globe', 'gem', 'clipboard-list', 'ruler', 'book-open', 'settings',
        'sparkles', 'heart', 'star', 'shield', 'zap', 'feather', 'compass', 'flag', 'tag', 'layers',
    ];
    for (const language of ['zh', 'en', 'ru']) {
        const options = getSettingsIconOptions(pick(language));
        assert.deepEqual(options.map(option => option.name), names);
        assert.ok(options.every(option => typeof option.label === 'string' && option.label.length > 0));
        if (language !== 'zh') assert.ok(options.every(option => !/\p{Script=Han}/u.test(option.label)));
    }
});

test('automatic endpoint names translate without changing user-named endpoints or configuration', () => {
    const config = { instanceName: '迁移的兼容端点', baseUrl: 'http://127.0.0.1:11434/v1', model: 'fixture-model' };
    const saved = structuredClone(config);
    assert.equal(getBuiltInEndpointName(config.instanceName, pick('en')), 'Migrated compatible endpoint');
    assert.equal(getBuiltInEndpointName(config.instanceName, pick('ru')), 'Перенесённый совместимый эндпоинт');
    assert.equal(getBuiltInEndpointName('我的测试端点', pick('en')), '我的测试端点');
    assert.deepEqual(config, saved);
});
