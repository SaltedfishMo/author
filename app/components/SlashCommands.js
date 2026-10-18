'use client';

import { useState, useEffect, useCallback, useRef, useLayoutEffect } from 'react';
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { createPortal } from 'react-dom';
import {
    Heading1, Heading2, Heading3, Quote, List, ListOrdered,
    CheckSquare, Code2, Minus, Sparkles
} from 'lucide-react';
import { useI18n } from '../lib/useI18n';

/**
 * 斜杠命令列表数据
 */
const COMMANDS = [
    { id: 'h1', labelKey: 'slashCommands.h1', keywords: 'h1 heading', icon: Heading1, action: (editor) => editor.chain().focus().toggleHeading({ level: 1 }).run() },
    { id: 'h2', labelKey: 'slashCommands.h2', keywords: 'h2 heading', icon: Heading2, action: (editor) => editor.chain().focus().toggleHeading({ level: 2 }).run() },
    { id: 'h3', labelKey: 'slashCommands.h3', keywords: 'h3 heading', icon: Heading3, action: (editor) => editor.chain().focus().toggleHeading({ level: 3 }).run() },
    { id: 'quote', labelKey: 'slashCommands.quote', keywords: 'quote blockquote', icon: Quote, action: (editor) => editor.chain().focus().toggleBlockquote().run() },
    { id: 'bullet', labelKey: 'slashCommands.bullet', keywords: 'bullet list ul', icon: List, action: (editor) => editor.chain().focus().toggleBulletList().run() },
    { id: 'ordered', labelKey: 'slashCommands.ordered', keywords: 'ordered list ol', icon: ListOrdered, action: (editor) => editor.chain().focus().toggleOrderedList().run() },
    { id: 'task', labelKey: 'slashCommands.task', keywords: 'task todo check', icon: CheckSquare, action: (editor) => editor.chain().focus().toggleTaskList().run() },
    { id: 'code', labelKey: 'slashCommands.code', keywords: 'code block', icon: Code2, action: (editor) => editor.chain().focus().toggleCodeBlock().run() },
    { id: 'divider', labelKey: 'slashCommands.divider', keywords: 'divider hr line', icon: Minus, action: (editor) => editor.chain().focus().setHorizontalRule().run() },
];

/**
 * 斜杠命令浮动菜单组件
 */
function SlashCommandMenu({ editor, range, onClose }) {
    const [query, setQuery] = useState('');
    const [selectedIndex, setSelectedIndex] = useState(0);
    const menuRef = useRef(null);
    const [pos, setPos] = useState(null);
    const [mounted, setMounted] = useState(false);

    const { t } = useI18n();

    useEffect(() => { setMounted(true); }, []);

    const filtered = COMMANDS.filter(cmd => {
        if (!query) return true;
        const q = query.toLowerCase();
        return t(cmd.labelKey).toLowerCase().includes(q) || cmd.id.includes(q) || cmd.keywords.includes(q);
    });

    // 获取光标位置
    useLayoutEffect(() => {
        if (!editor || !range) return;
        try {
            const coords = editor.view.coordsAtPos(range.from);
            setPos({ left: coords.left, top: coords.bottom + 4 });
        } catch { /* ignore */ }
    }, [editor, range]);

    // 执行命令
    const executeCommand = useCallback((cmd) => {
        // 删除 / 和查询文字
        editor.chain().focus().deleteRange(range).run();
        cmd.action(editor);
        onClose();
    }, [editor, range, onClose]);

    // 键盘导航
    useEffect(() => {
        const handler = (e) => {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                e.stopPropagation();
                setSelectedIndex(i => (i + 1) % (filtered.length || 1));
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                e.stopPropagation();
                setSelectedIndex(i => (i - 1 + (filtered.length || 1)) % (filtered.length || 1));
            } else if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                if (filtered[selectedIndex]) {
                    executeCommand(filtered[selectedIndex]);
                }
            } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                onClose();
            } else if (e.key === 'Backspace') {
                // 如果删光了 / 字符，关闭菜单
                const { from } = editor.state.selection;
                const textBefore = editor.state.doc.textBetween(range.from, from, '');
                if (textBefore.length <= 1) {
                    // 即将删除 / 或已经没有内容
                    onClose();
                }
            }
        };
        document.addEventListener('keydown', handler, true);
        return () => document.removeEventListener('keydown', handler, true);
    }, [filtered, selectedIndex, editor, range, onClose, executeCommand]);

    // 监听编辑器内容变化来更新搜索词
    useEffect(() => {
        if (!editor || !range) return;
        const updateQuery = () => {
            const { from } = editor.state.selection;
            if (from <= range.from) { onClose(); return; }
            const text = editor.state.doc.textBetween(range.from, from, '');
            // 去掉开头的 /
            setQuery(text.startsWith('/') ? text.slice(1) : text);
        };
        editor.on('selectionUpdate', updateQuery);
        editor.on('update', updateQuery);
        return () => {
            editor.off('selectionUpdate', updateQuery);
            editor.off('update', updateQuery);
        };
    }, [editor, range, onClose]);

    // 边界修正
    useLayoutEffect(() => {
        if (!menuRef.current || !pos) return;
        const rect = menuRef.current.getBoundingClientRect();
        const vh = window.innerHeight;
        if (pos.top + rect.height > vh - 8) {
            try {
                const coords = editor.view.coordsAtPos(range.from);
                setPos(p => ({ ...p, top: coords.top - rect.height - 4 }));
            } catch { /* ignore */ }
        }
    }, [pos, editor, range]);

    useEffect(() => { setSelectedIndex(0); }, [query]);

    if (!mounted || !pos || filtered.length === 0) return null;

    return createPortal(
        <>
            <div style={{ position: 'fixed', inset: 0, zIndex: 9990 }} onClick={onClose} />
            {/* 阻止 mousedown 抢走编辑器焦点：失焦期间 ProseMirror 不同步 DOM 选区，
                列表命令执行后浏览器选区会停在被复用为末尾空段的旧段落里，紧接着输入的文字会落到那里 */}
            <div ref={menuRef} className="slash-menu" style={{ position: 'fixed', left: pos.left, top: pos.top, zIndex: 9991 }} onMouseDown={e => e.preventDefault()}>
                {filtered.map((cmd, i) => {
                    const Icon = cmd.icon;
                    return (
                        <button
                            key={cmd.id}
                            className={`slash-item${i === selectedIndex ? ' active' : ''}`}
                            onClick={() => executeCommand(cmd)}
                            onMouseEnter={() => setSelectedIndex(i)}
                        >
                            <Icon size={16} />
                            <span>{t(cmd.labelKey)}</span>
                        </button>
                    );
                })}
            </div>
        </>,
        document.body
    );
}

/**
 * Tiptap 斜杠命令扩展 — 在空行输入 / 触发命令面板
 * 使用 ProseMirror handleTextInput 插件代替 addKeyboardShortcuts
 */
export function createSlashExtension(onSlash) {
    return Extension.create({
        name: 'slashCommands',

        addProseMirrorPlugins() {
            return [
                new Plugin({
                    key: new PluginKey('slashCommands'),
                    props: {
                        handleTextInput(view, from, to, text) {
                            if (text !== '/') return false;

                            // 仅在行首（空行或行首）触发
                            const { $from } = view.state.selection;
                            const textBefore = $from.parent.textContent.slice(0, $from.parentOffset);
                            if (textBefore.length > 0) return false;

                            // 插入 / 并触发菜单
                            // 先让默认 insert 发生，下一帧触发菜单
                            setTimeout(() => {
                                const pos = view.state.selection.from;
                                onSlash({ from: pos - 1, to: pos });
                            }, 0);

                            return false; // 让默认 input 继续执行，插入 / 字符
                        },
                    },
                }),
            ];
        },
    });
}

export { SlashCommandMenu, COMMANDS };
