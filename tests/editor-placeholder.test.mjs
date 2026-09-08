import test from 'node:test';
import assert from 'node:assert/strict';
import { Schema } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import { history, undo, undoDepth, redoDepth } from '@tiptap/pm/history';
import Placeholder from '@tiptap/extension-placeholder';
import { getEditorPlaceholder, refreshEditorPlaceholder } from '../app/lib/editor-placeholder.js';

const schema = new Schema({ nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'text*' },
    text: {},
} });

function makeEditor(getLanguage) {
    const extension = Placeholder.configure({ placeholder: () => getEditorPlaceholder(getLanguage()) });
    const editor = { isEditable: true, get isEmpty() { return !view.state.doc.textContent; } };
    const plugin = extension.config.addProseMirrorPlugins.call({ editor, options: extension.options })[0];
    const transactions = [];
    const view = {
        state: EditorState.create({ schema, plugins: [plugin, history()] }),
        dispatch(transaction) {
            transactions.push(transaction);
            view.state = view.state.apply(transaction);
        },
    };
    return { view, transactions, plugin };
}

test('the existing placeholder plugin follows language changes without recreating the editor', () => {
    let language = 'en';
    const { view, plugin } = makeEditor(() => language);
    const originalDoc = view.state.doc;
    const expected = {
        en: 'Start writing... let inspiration flow',
        ru: 'Начните писать... пусть вдохновение течёт',
        zh: '开始写作…让灵感自由流淌',
    };
    for (language of ['en', 'ru', 'zh', 'en']) {
        refreshEditorPlaceholder(view);
        const decorations = plugin.props.decorations(view.state).find();
        assert.equal(decorations.length, 1);
        assert.equal(decorations[0].type.attrs['data-placeholder'], expected[language]);
        assert.equal(view.state.doc, originalDoc);
        assert.equal(undoDepth(view.state), 0);
    }
});

test('language refresh preserves text, selection and undo/redo history and never requests a content save', () => {
    const { view, transactions } = makeEditor(() => 'en');
    view.dispatch(view.state.tr.insertText('正文保持原样'));
    const originalDoc = view.state.doc;
    const originalSelection = view.state.selection;
    const depth = undoDepth(view.state);
    assert.equal(depth, 1);

    refreshEditorPlaceholder(view);
    assert.equal(view.state.doc, originalDoc);
    assert.ok(view.state.selection.eq(originalSelection));
    assert.equal(undoDepth(view.state), depth);
    assert.equal(transactions.at(-1).docChanged, false);
    assert.equal(transactions.at(-1).getMeta('addToHistory'), false);
    assert.equal(transactions.at(-1).getMeta('preventUpdate'), true);

    assert.equal(undo(view.state, view.dispatch), true);
    assert.equal(view.state.doc.textContent, '');
    refreshEditorPlaceholder(view);
    assert.equal(redoDepth(view.state), 1);
});
