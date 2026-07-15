# HTMLive

> Edit living HTML, instantly.

HTMLive is a bookmarklet for directly editing an already-open HTML page. It
keeps the page's existing CSS, JavaScript, and motion in place while giving
you a slide-like visual editing layer: select a component, change its text or
style, move or resize it, then save an updated HTML file.

## Why HTMLive

AI can generate a polished animated HTML page quickly, but small follow-up
changes often require another prompt, a new generation, and another review.
HTMLive closes that gap: make the final visual adjustment directly on the live
page instead of restarting a conversation.

## Features

- Visual element selection, multi-selection, and parent/child navigation
- Direct text editing: double-click a text component in edit mode
- Component movement and resize handles
- Style drawer for text color, font size, and font family
- Undo/redo for direct edits; per-change undo for AI edits
- Optional AI chat preview using an OpenAI-compatible endpoint
- Export the edited DOM as a standalone HTML file
- No build step and no application backend; the bookmarklet runs in the page

## Install

1. Open the deployed install page over HTTP(S).
2. Drag the **HTMLive** button to your browser bookmarks bar.
3. Open an HTML page and click the bookmark.

The bookmark embeds the current `assets/editor.css` and `assets/editor.js` at
drag time. After an HTMLive update, refresh the install page and drag the
button again to replace the old bookmark.

## Edit workflow

1. Click an element to select it, then choose **进入编辑模式**.
2. Double-click text to edit it directly.
3. Drag `⠿` to move the selected component and `↘` to resize it.
4. Open **样式** to adjust its font color, size, and family.
5. Use `⌘/Ctrl + Z` to undo and `⌘/Ctrl + Shift + Z` to redo.
6. Choose **导出 HTML** to save the edited page.

On browsers that support the File System Access API, export opens a Save As
dialog. Other browsers download an `-edited.html` file. A bookmarklet cannot
silently overwrite an arbitrary local file.

## Local development

```bash
python3 -m http.server 4173 --bind 127.0.0.1
```

Open `http://127.0.0.1:4173/index.html` and drag the generated bookmarklet to
the bookmarks bar.

## Project structure

```text
index.html          Bookmarklet install page
assets/editor.js    In-page selection, editing, AI, history, and export logic
assets/editor.css   In-page editor UI styles
```

## Acknowledgements

Inspired by [oil-oil/selector](https://github.com/oil-oil/selector).
