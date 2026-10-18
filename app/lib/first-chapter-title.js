// 首次打开时会自动建一个默认第一章。那一刻用户可能还没在欢迎窗口选语言，
// 章名只能先按默认语言起；语言选定后，用这里的判断找出那个还没被动过的默认章节，
// 改成所选语言的默认名。改过标题、写过正文或概要的章节一律不动。

// 空文档在编辑器里可能存成 '<p></p>' 或 '<p><br></p>'；其他任何标记（图片、分隔线等）都算有内容
const BLANK_MARKUP = /<\/?p>|<br\s*\/?>|&nbsp;|\s/gi;

export function isBlankChapterContent(content) {
    if (content === undefined || content === null) return true;
    if (typeof content !== 'string') return false;
    return content.replace(BLANK_MARKUP, '') === '';
}

// 作品里只有一个章节、标题仍是某种语言的默认名、正文和概要都为空时，返回要改成的新标题；否则返回 null
export function getDefaultFirstChapterRetitle(chapters, { defaultTitles, nextTitle }) {
    if (!Array.isArray(chapters) || chapters.length !== 1) return null;
    const [chapter] = chapters;
    if (!chapter?.id || (chapter.type || 'chapter') !== 'chapter') return null;
    if (!nextTitle || chapter.title === nextTitle) return null;
    if (!Array.isArray(defaultTitles) || !defaultTitles.includes(chapter.title)) return null;
    if (chapter.wordCount || !isBlankChapterContent(chapter.content)) return null;
    if (chapter.synopsis || chapter.chapterSynopsis || chapter.summary) return null;
    return { id: chapter.id, title: nextTitle };
}
