import { getTextBetween, getTextSerializersFromSchema } from '@tiptap/core';

export function getEditorAiReferenceText(editor, { from, to, blockSeparator, excludeStrikethrough = false } = {}) {
    if (!editor) return '';
    const fullDocument = from == null && to == null;
    const range = { from: from ?? 0, to: to ?? editor.state.doc.content.size };
    const separator = blockSeparator ?? (fullDocument ? '\n\n' : ' ');
    if (!excludeStrikethrough) {
        return fullDocument ? editor.getText() : editor.state.doc.textBetween(range.from, range.to, separator);
    }
    const serializers = getTextSerializersFromSchema(editor.schema);
    const isStruck = node => node.marks.some(mark => mark.type.name === 'strike' || mark.type.name === 'aiDiffDelete');
    const textSerializers = Object.fromEntries(Object.entries(serializers).map(([name, serialize]) => [
        name, props => isStruck(props.node) ? '' : serialize(props),
    ]));
    textSerializers.text = props => {
        if (isStruck(props.node)) return '';
        return serializers.text ? serializers.text(props) : props.node.text.slice(Math.max(range.from, props.pos) - props.pos, range.to - props.pos);
    };
    return getTextBetween(editor.state.doc, range, { blockSeparator: separator, textSerializers });
}
