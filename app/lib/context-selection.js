export function getChapterReferenceGroups(chapters, text) {
    const hasVolumes = chapters.some(chapter => chapter.type === 'volume');
    const groups = new Map();
    let volume = null;
    for (const chapter of chapters) {
        if (chapter.type === 'volume') {
            volume = chapter;
            continue;
        }
        groups.set(chapter.id, {
            groupId: hasVolumes ? (volume ? `volume:${volume.id}` : 'chapters-unfiled') : 'chapters',
            group: hasVolumes
                ? (volume ? volume.title || text('未命名分卷', 'Untitled volume', 'Том без названия') : text('未分卷章节', 'Unfiled chapters', 'Главы вне томов'))
                : text('章节', 'Chapters', 'Главы'),
            _volumeId: volume?.id ?? null,
            _chapterId: chapter.id,
        });
    }
    return groups;
}

export function getContextGroupId(item) {
    return item.groupId || item.group || 'other';
}

export function groupContextItems(items, search = '') {
    const groups = Object.create(null);
    const query = search.trim().toLowerCase();
    for (const item of items || []) {
        if (item._empty) continue;
        if (query && !item.name.toLowerCase().includes(query) && !item.group?.toLowerCase().includes(query)) continue;
        const key = getContextGroupId(item);
        (groups[key] ||= []).push(item);
    }
    return groups;
}

export function getSelectedContextChapterIds(items, selection) {
    const ids = new Set();
    for (const item of items || []) {
        if (!item.alwaysInclude && !selection?.has(item.id)) continue;
        if (item._chapterId) ids.add(item._chapterId);
        for (const id of item._chapterIds || []) ids.add(id);
    }
    return ids;
}

export function isContextItemSelected(item, selection, selectedChapterIds) {
    return !!(item.alwaysInclude || selection?.has(item.id) || (item._chapterId && selectedChapterIds?.has(item._chapterId)));
}

export function toggleContextReferences(selection, targets, allItems) {
    const next = new Set(selection);
    const selectable = targets.filter(item => !item._empty && !item.alwaysInclude);
    if (!selectable.length) return next;
    const covered = getSelectedContextChapterIds(allItems, selection);
    const remove = selectable.every(item => isContextItemSelected(item, selection, covered));
    for (const item of selectable) {
        if (remove) next.delete(item.id);
        else next.add(item.id);
    }
    if (remove) {
        const removedChapterIds = new Set(selectable.map(item => item._chapterId).filter(Boolean));
        const chapterItems = new Map(allItems.filter(item => item._chapterId).map(item => [item._chapterId, item]));
        // Split overlapping synopsis selections so an unchecked chapter cannot leak through a group.
        for (const item of allItems) {
            if (!next.has(item.id) || !item._chapterIds?.some(id => removedChapterIds.has(id))) continue;
            next.delete(item.id);
            for (const id of item._chapterIds) {
                const chapterItem = chapterItems.get(id);
                if (chapterItem && !removedChapterIds.has(id)) next.add(chapterItem.id);
            }
        }
    }
    return next;
}

export function reconcileContextSelection(selection, items, reset = false, previousItems = []) {
    if (reset) return new Set(items.filter(item => item.enabled || item.alwaysInclude).map(item => item.id));
    const validIds = new Set(items.map(item => item.id));
    const next = new Set([...selection].filter(id => validIds.has(id)));
    const chapterItems = new Map(items.filter(item => item._chapterId).map(item => [item._chapterId, item]));
    // If filtering invalidates a cached synopsis, retain its selected chapters as clean source references.
    for (const item of previousItems) {
        if (!selection.has(item.id) || validIds.has(item.id)) continue;
        for (const id of item._chapterIds || []) {
            const chapterItem = chapterItems.get(id);
            if (chapterItem) next.add(chapterItem.id);
        }
    }
    for (const item of items) if (item.alwaysInclude) next.add(item.id);
    return next;
}
