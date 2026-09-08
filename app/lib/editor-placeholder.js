export function getEditorPlaceholder(language) {
    if (language === 'en') return 'Start writing... let inspiration flow';
    if (language === 'ru') return 'Начните писать... пусть вдохновение течёт';
    return '开始写作…让灵感自由流淌';
}

export function refreshEditorPlaceholder(view) {
    if (!view) return;
    view.dispatch(view.state.tr
        .setMeta('addToHistory', false)
        .setMeta('preventUpdate', true));
}
