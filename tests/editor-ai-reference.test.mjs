import test from 'node:test';
import assert from 'node:assert/strict';
import { Schema } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { getText, getTextSerializersFromSchema } from '@tiptap/core';
import { getEditorAiReferenceText } from '../app/lib/editor-ai-reference.js';

const schema = new Schema({
    nodes: {
        doc: { content: 'paragraph+' },
        paragraph: { content: 'inline*', group: 'block' },
        text: { group: 'inline' },
        hardBreak: { group: 'inline', inline: true, toText: () => '\n' },
        formula: { group: 'inline', inline: true, attrs: { value: {} }, toText: ({ node }) => `$${node.attrs.value}$` },
    },
    marks: { strike: {}, bold: {}, aiDiffDelete: {} },
});
const marked = (value, name = 'strike') => schema.text(value, [schema.marks[name].create()]);
function editorFixture() {
    const doc = schema.node('doc', null, [
        schema.node('paragraph', null, [schema.text('alpha '), marked('old'), schema.text(' omega'), schema.node('hardBreak'), schema.text('next')]),
        schema.node('paragraph', null, [schema.text('formula '), schema.node('formula', { value: 'x+y' }), schema.text(' '), schema.node('formula', { value: 'old' }, null, [schema.marks.strike.create()]), marked('bold', 'bold'), marked('pending', 'aiDiffDelete')]),
    ]);
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, 3, 14) });
    return { schema, state, getText: () => getText(doc, { textSerializers: getTextSerializersFromSchema(schema) }) };
}

test('disabled filtering exactly preserves existing full-document and selection extraction', () => {
    const editor = editorFixture();
    assert.equal(getEditorAiReferenceText(editor), editor.getText());
    assert.equal(getEditorAiReferenceText(editor, { from: 3, to: 14 }), editor.state.doc.textBetween(3, 14, ' '));
    assert.match(getEditorAiReferenceText(editor), /old/);
});

test('filtered editor text preserves paragraph breaks, bold text, hard breaks, and math serializers', () => {
    const editor = editorFixture();
    const before = editor.state.toJSON();
    const state = editor.state;
    assert.equal(getEditorAiReferenceText(editor, { excludeStrikethrough: true }), 'alpha  omega\nnext\n\nformula $x+y$ bold');
    assert.equal(editor.state, state);
    assert.deepEqual(editor.state.toJSON(), before);
});

test('partial selections respect ProseMirror positions across struck text', () => {
    const editor = editorFixture();
    assert.equal(getEditorAiReferenceText(editor, { from: 3, to: 14, excludeStrikethrough: true }), 'pha  ome');
    assert.equal(getEditorAiReferenceText(editor, { from: 7, to: 10, excludeStrikethrough: true }), '');
    assert.equal(getEditorAiReferenceText(editor, { from: 8, to: 9, excludeStrikethrough: true }), '');
    assert.equal(getEditorAiReferenceText(null, { excludeStrikethrough: true }), '');
});
