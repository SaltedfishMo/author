const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const STRIKE_TAGS = new Set(['s', 'strike', 'del']);

function hasStrikeStyle(tag) {
    const attributes = /\s+([^\s=/<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    for (const match of tag.matchAll(attributes)) {
        if (match[1].toLowerCase() !== 'style') continue;
        return /(?:^|;)\s*text-decoration(?:-line)?\s*:[^;]*\bline-through\b/i.test(match[2] ?? match[3] ?? match[4] ?? '');
    }
    return false;
}

// Filter only the outbound copy. Keep nested markup and literal, escaped tag text intact.
export function filterStrikethroughHtml(html) {
    const source = String(html || '');
    const tags = /<!--[\s\S]*?-->|<![^>]*>|<\/?([a-z][\w:-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
    const stack = [];
    let output = '';
    let cursor = 0;
    let hidden = false;
    for (const match of source.matchAll(tags)) {
        if (!hidden) output += source.slice(cursor, match.index);
        const tag = match[0];
        const name = match[1]?.toLowerCase();
        if (!name) {
            if (!hidden) output += tag;
        } else if (/^<\//.test(tag)) {
            const index = stack.findLastIndex(frame => frame.name === name);
            if (index >= 0) {
                const frame = stack[index];
                if (!frame.hidden) output += tag;
                stack.length = index;
                hidden = stack.at(-1)?.hidden || false;
            } else if (!hidden) output += tag;
        } else {
            const nextHidden = hidden || STRIKE_TAGS.has(name) || hasStrikeStyle(tag);
            if (!nextHidden) output += tag;
            if (!VOID_TAGS.has(name) && !/\/\s*>$/.test(tag)) {
                stack.push({ name, hidden: nextHidden });
                hidden = nextHidden;
            }
        }
        cursor = match.index + tag.length;
    }
    if (!hidden) output += source.slice(cursor);
    return output;
}

export function prepareChapterForAi(chapter, excludeStrikethrough = false) {
    if (!excludeStrikethrough || !chapter || chapter.type === 'volume') return chapter;
    const content = filterStrikethroughHtml(chapter.content);
    if (content === (chapter.content || '')) return chapter;
    // Stored synopses may still describe the excluded passage. Use clean source text for this request.
    return { ...chapter, content, synopsis: null, chapterSynopsis: null, summary: '', _aiReferenceFiltered: true };
}

export function prepareChaptersForAi(chapters, excludeStrikethrough = false) {
    return excludeStrikethrough ? chapters.map(chapter => prepareChapterForAi(chapter, true)) : chapters;
}

export function filterMemoryGroupsForAi(groups, chapters) {
    const filteredIds = new Set(chapters.filter(chapter => chapter._aiReferenceFiltered).map(chapter => chapter.id));
    return groups.filter(group => !(group.chapterIds || []).some(id => filteredIds.has(id)));
}
