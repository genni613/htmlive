/**
 * HTMLive — visual, in-page HTML editor.
 * Inject via bookmarklet. Click = select, Shift+click = multi, Drag = marquee.
 */
(function () {
  "use strict";

  if (document.querySelector(".ai-editor-root")) return;

  const NS = "ai-editor";
  const AI_ID = "data-ai-id";
  const EXPORT_REMOVALS_KEY = "__htmliveExportRemovalSelectors";

  let selectedElements = [];
  let chatPanel = null;
  let hoverBox = null;
  let aiIdCounter = 0;
  let rafPending = false;
  let lastMoveTarget = null;
  let minimized = false;
  let paused = false;
  const selOverlays = new Map();
  const annotations = new Map();
  const listeners = [];
  let dragState = null;
  let wasJustDragging = false;
  let activePopover = null;
  const selectionHistory = [];

  // ── Chat state ────────────────────────────────────────────
  const chatMessages = [];
  let isStreaming = false;
  const snapshotStack = [];
  let snapshotIdCounter = 0;
  let activeAbortController = null;
  let settingsPopover = null;
  let closeConfirmEl = null;
  let editMode = false;
  let textEditState = null;
  let directManipulation = null;
  let styleDrawerOpen = false;
  const domHistory = [];
  const domRedoStack = [];
  const exportedRemovalRules = new Map(
    (Array.isArray(window[EXPORT_REMOVALS_KEY]) ? window[EXPORT_REMOVALS_KEY] : [])
      .filter((rule) => rule && typeof rule.selector === "string")
      .map((rule) => [JSON.stringify(rule), rule])
  );


  function on(target, type, fn, capture) {
    target.addEventListener(type, fn, capture);
    listeners.push({ target, type, fn, capture });
  }

  // ── Init ───────────────────────────────────────────────────
  function init() {
    assignAiIds(document.body);
    createHoverBox();
    createChatPanel();

    on(document, "mousedown", handleMouseDown, true);
    on(document, "click", handleClick, true);
    on(document, "mousemove", handleMouseMove, true);
    on(document, "mouseup", handleMouseUp, true);
    on(document, "dblclick", handleDoubleClick, true);
    on(document, "mouseleave", () => { showHover(null); cancelDrag(); }, true);
    on(document, "keydown", handleKeyDown, true);

    let repositionRaf = false;
    const scheduleReposition = () => {
      if (!repositionRaf) {
        repositionRaf = true;
        requestAnimationFrame(() => { positionAllOverlays(); repositionRaf = false; });
      }
    };
    on(window, "scroll", scheduleReposition, true);
    on(window, "resize", scheduleReposition, false);
  }

  // ── Destroy ────────────────────────────────────────────────
  function destroy() {
    if (snapshotStack.length > 0) {
      showCloseConfirm();
      return;
    }
    doDestroy(false);
  }

  function doDestroy(keepChanges) {
    abortStream();
    chatMessages.length = 0;
    isStreaming = false;

    if (!keepChanges) {
      for (let i = snapshotStack.length - 1; i >= 0; i--) {
        const snapshot = snapshotStack[i];
        for (let j = snapshot.entries.length - 1; j >= 0; j--) {
          const entry = snapshot.entries[j];
          if (entry.action === "remove") {
            const parent = entry.parentAiId ? byAiId(entry.parentAiId)
              : entry.parentSelector ? document.querySelector(entry.parentSelector)
              : null;
            if (!parent) continue;
            const tmp = document.createElement("div");
            tmp.innerHTML = entry.outerHTML;
            const restored = tmp.firstElementChild;
            if (!restored) continue;
            const next = entry.nextSiblingAiId ? byAiId(entry.nextSiblingAiId) : null;
            if (next) parent.insertBefore(restored, next);
            else parent.appendChild(restored);
          } else {
            const el = entry.aiId ? byAiId(entry.aiId)
              : document.querySelector(entry.selector);
            if (!el) continue;
            const tmp = document.createElement("div");
            tmp.innerHTML = entry.outerHTML;
            const restored = tmp.firstElementChild;
            if (restored) el.replaceWith(restored);
          }
        }
      }
    }
    for (const { target, type, fn, capture } of listeners) {
      target.removeEventListener(type, fn, capture);
    }
    destroyAllOverlays();
    removeAnnotationPopover();
    removeSettingsPopover();
    if (hoverBox) hoverBox.remove();
    if (chatPanel) chatPanel.remove();
    removeCloseConfirm();
    snapshotStack.length = 0;
  }

  function showCloseConfirm() {
    removeCloseConfirm();
    const dialog = document.createElement("div");
    dialog.className = `${NS}-root ${NS}-confirm-dialog`;
    dialog.innerHTML = `
      <div class="${NS}-confirm-text">页面已被修改，是否保留？</div>
      <div class="${NS}-confirm-actions">
        <button class="${NS}-confirm-btn ${NS}-confirm-discard" data-action="discard">放弃</button>
        <button class="${NS}-confirm-btn ${NS}-confirm-keep" data-action="keep">保留</button>
      </div>
    `;
    document.body.appendChild(dialog);
    closeConfirmEl = dialog;
    dialog.querySelector('[data-action="keep"]').onclick = (e) => { e.stopPropagation(); doDestroy(true); };
    dialog.querySelector('[data-action="discard"]').onclick = (e) => { e.stopPropagation(); doDestroy(false); };
    dialog.addEventListener("click", (e) => e.stopPropagation());
    dialog.addEventListener("keydown", (e) => e.stopPropagation());
  }

  function removeCloseConfirm() {
    if (closeConfirmEl) { closeConfirmEl.remove(); closeConfirmEl = null; }
  }

  // ── AI-ID ──────────────────────────────────────────────────
  function assignAiIds(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node;
    while ((node = walker.nextNode())) {
      if (isEditorElement(node)) continue;
      if (!node.hasAttribute(AI_ID)) node.setAttribute(AI_ID, `el-${aiIdCounter++}`);
    }
  }

  function isEditorElement(el) {
    return el && el.closest && !!el.closest(`.${NS}-root`);
  }

  function byAiId(id) {
    return document.querySelector(`[${AI_ID}="${id}"]`);
  }

  // ── Resolve target ─────────────────────────────────────────
  function resolveTarget(el) {
    let cur = el;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      if (isEditorElement(cur)) { cur = cur.parentElement; continue; }
      if (!isVisible(cur)) { cur = cur.parentElement; continue; }
      if (isMeaningful(cur)) return cur;
      cur = cur.parentElement;
    }
    return el;
  }

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 && r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0";
  }

  function isMeaningful(el) {
    if (hasDirectText(el)) return true;
    if (el.querySelector("img,video,canvas,svg,button,a,input,select,textarea,iframe")) return true;
    if (el.children.length > 1) return true;
    return false;
  }

  function hasDirectText(el) {
    for (const n of el.childNodes) {
      if (n.nodeType === 3 && n.textContent.trim()) return true;
    }
    return false;
  }

  // ── Hover overlay ──────────────────────────────────────────
  function createHoverBox() {
    hoverBox = document.createElement("div");
    hoverBox.className = `${NS}-hover-box`;
    document.body.appendChild(hoverBox);
  }

  function showHover(el) {
    if (!el || isEditorElement(el) || selectedElements.includes(el)) {
      hoverBox.style.opacity = "0";
      return;
    }
    const r = el.getBoundingClientRect();
    hoverBox.style.top = (r.top - 1) + "px";
    hoverBox.style.left = (r.left - 1) + "px";
    hoverBox.style.width = (r.width + 2) + "px";
    hoverBox.style.height = (r.height + 2) + "px";
    hoverBox.style.opacity = "1";
  }

  // ── Mouse handling ─────────────────────────────────────────
  function handleMouseMove(e) {
    if (isTextEditing(e.target)) return;
    if (minimized || paused) return;

    if (dragState) {
      const dx = e.clientX - dragState.startX;
      const dy = e.clientY - dragState.startY;

      if (!dragState.isDragging && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
        dragState.isDragging = true;
        dragState.marquee = document.createElement("div");
        dragState.marquee.className = `${NS}-marquee`;
        document.body.appendChild(dragState.marquee);
        showHover(null);
      }

      if (dragState.isDragging) {
        const left = Math.min(e.clientX, dragState.startX);
        const top = Math.min(e.clientY, dragState.startY);
        dragState.marquee.style.left = left + "px";
        dragState.marquee.style.top = top + "px";
        dragState.marquee.style.width = Math.abs(dx) + "px";
        dragState.marquee.style.height = Math.abs(dy) + "px";
        return;
      }
    }

    lastMoveTarget = resolveTarget(e.target);
    if (!rafPending) {
      rafPending = true;
      requestAnimationFrame(() => { showHover(lastMoveTarget); rafPending = false; });
    }
  }

  function handleMouseDown(e) {
    if (isTextEditing(e.target)) return;
    if (isEditorElement(e.target)) return;
    if (minimized || paused) return;
    if (e.button !== 0) return;
    if (e.shiftKey) e.preventDefault();

    dragState = {
      startX: e.clientX,
      startY: e.clientY,
      isDragging: false,
      marquee: null,
    };
  }

  function handleMouseUp(e) {
    if (!dragState || !dragState.isDragging) {
      dragState = null;
      return;
    }

    wasJustDragging = true;

    const mRect = dragState.marquee.getBoundingClientRect();
    dragState.marquee.remove();
    dragState = null;

    pushHistory();
    if (!e.shiftKey) clearSelection();

    document.querySelectorAll(`[${AI_ID}]`).forEach((el) => {
      if (isEditorElement(el)) return;
      if (!isVisible(el)) return;
      if (!isMeaningful(el)) return;
      const r = el.getBoundingClientRect();
      if (rectsIntersect(mRect, r)) addSelection(el);
    });

    updateTags();
    setTimeout(() => { wasJustDragging = false; }, 0);
  }

  function cancelDrag() {
    if (dragState && dragState.marquee) dragState.marquee.remove();
    dragState = null;
  }

  function rectsIntersect(a, b) {
    return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
  }

  function handleClick(e) {
    if (isTextEditing(e.target)) return;
    if (isEditorElement(e.target)) return;
    if (minimized || paused) return;
    if (wasJustDragging) return;

    e.preventDefault();
    e.stopPropagation();
    removeAnnotationPopover();
    removeSettingsPopover();
    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();

    pushHistory();
    const el = resolveTarget(e.target);
    if (e.shiftKey) {
      toggleElement(el);
    } else {
      clearSelection();
      addSelection(el);
    }
    updateTags();
  }

  // ── Selection overlays ─────────────────────────────────────
  function createSelOverlay(el) {
    const aiId = el.getAttribute(AI_ID);
    if (selOverlays.has(aiId)) return;

    const box = document.createElement("div");
    box.className = `${NS}-sel-box`;

    const corners = [0, 1, 2, 3].map((i) => {
      const c = document.createElement("div");
      c.className = `${NS}-sel-corner`;
      c.style.animationDelay = `${i * 28}ms`;
      document.body.appendChild(c);
      return c;
    });

    const label = document.createElement("div");
    label.className = `${NS}-sel-label`;
    label.textContent = elementLabel(el);

    const annotateBtn = document.createElement("button");
    annotateBtn.className = `${NS}-root ${NS}-annotate-btn`;
    annotateBtn.title = "添加标注";
    annotateBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
    annotateBtn.onclick = (e) => {
      e.stopPropagation();
      e.preventDefault();
      showAnnotationPopover(el, annotateBtn);
    };

    const moveHandle = document.createElement("button");
    moveHandle.className = `${NS}-edit-handle ${NS}-move-handle`;
    moveHandle.type = "button";
    moveHandle.title = "拖动元素";
    moveHandle.textContent = "⠿";
    moveHandle.addEventListener("pointerdown", (e) => startDirectMove(e, el));

    const resizeHandle = document.createElement("button");
    resizeHandle.className = `${NS}-edit-handle ${NS}-resize-handle`;
    resizeHandle.type = "button";
    resizeHandle.title = "调整大小";
    resizeHandle.textContent = "↘";
    resizeHandle.addEventListener("pointerdown", (e) => startDirectResize(e, el));

    document.body.appendChild(box);
    document.body.appendChild(label);
    document.body.appendChild(annotateBtn);
    document.body.appendChild(moveHandle);
    document.body.appendChild(resizeHandle);
    selOverlays.set(aiId, { box, corners, label, annotateBtn, moveHandle, resizeHandle });
    positionSelOverlay(el);
  }

  function positionSelOverlay(el) {
    const aiId = el.getAttribute(AI_ID);
    const ov = selOverlays.get(aiId);
    if (!ov) return;
    const r = el.getBoundingClientRect();
    const pad = 2;

    ov.box.style.top = (r.top - pad) + "px";
    ov.box.style.left = (r.left - pad) + "px";
    ov.box.style.width = (r.width + pad * 2) + "px";
    ov.box.style.height = (r.height + pad * 2) + "px";

    const cs = 6;
    const pos = [
      { top: r.top - pad - cs / 2,    left: r.left - pad - cs / 2 },
      { top: r.top - pad - cs / 2,    left: r.right + pad - cs / 2 },
      { top: r.bottom + pad - cs / 2, left: r.left - pad - cs / 2 },
      { top: r.bottom + pad - cs / 2, left: r.right + pad - cs / 2 },
    ];
    for (let i = 0; i < 4; i++) {
      ov.corners[i].style.top = pos[i].top + "px";
      ov.corners[i].style.left = pos[i].left + "px";
    }

    ov.label.style.top = (r.top - pad - 20) + "px";
    ov.label.style.left = (r.left - pad) + "px";

    ov.annotateBtn.style.top = (r.top - pad - 22) + "px";
    ov.annotateBtn.style.left = (r.right + pad + 4) + "px";
    ov.moveHandle.style.top = (r.top - pad - 22) + "px";
    ov.moveHandle.style.left = Math.max(4, r.left - pad) + "px";
    ov.resizeHandle.style.top = (r.bottom - 8) + "px";
    ov.resizeHandle.style.left = (r.right - 8) + "px";
    const showEditHandles = editMode && selectedElements.length === 1;
    ov.moveHandle.style.display = showEditHandles ? "flex" : "none";
    ov.resizeHandle.style.display = showEditHandles ? "flex" : "none";

    if (annotations.has(aiId)) {
      ov.annotateBtn.classList.add(`${NS}-has-note`);
    } else {
      ov.annotateBtn.classList.remove(`${NS}-has-note`);
    }
  }

  function positionAllOverlays() {
    for (const el of selectedElements) positionSelOverlay(el);
  }

  function destroySelOverlay(aiId) {
    const ov = selOverlays.get(aiId);
    if (!ov) return;
    ov.box.remove();
    ov.corners.forEach(c => c.remove());
    ov.label.remove();
    ov.annotateBtn.remove();
    ov.moveHandle.remove();
    ov.resizeHandle.remove();
    selOverlays.delete(aiId);
  }

  function destroyAllOverlays() {
    for (const [aiId] of selOverlays) destroySelOverlay(aiId);
  }

  function addSelection(el) {
    if (!selectedElements.includes(el)) {
      selectedElements.push(el);
      createSelOverlay(el);
    }
  }

  function removeSelection(el) {
    const idx = selectedElements.indexOf(el);
    if (idx >= 0) {
      selectedElements.splice(idx, 1);
      const aiId = el.getAttribute(AI_ID);
      destroySelOverlay(aiId);
      annotations.delete(aiId);
    }
  }

  function toggleElement(el) {
    selectedElements.includes(el) ? removeSelection(el) : addSelection(el);
  }

  function clearSelection() {
    destroyAllOverlays();
    selectedElements = [];
    annotations.clear();
    removeAnnotationPopover();
  }

  // ── Selection history (undo) ────────────────────────────────
  function pushHistory() {
    selectionHistory.push({
      elements: [...selectedElements],
      annotations: new Map(annotations),
    });
    if (selectionHistory.length > 30) selectionHistory.shift();
  }

  function undo() {
    if (selectionHistory.length === 0) return;
    const state = selectionHistory.pop();
    destroyAllOverlays();
    removeAnnotationPopover();
    selectedElements = state.elements;
    annotations.clear();
    for (const [k, v] of state.annotations) annotations.set(k, v);
    for (const el of selectedElements) createSelOverlay(el);
    updateTags();
  }

  // ── Parent / child navigation ─────────────────────────────
  function navigateToParent() {
    if (selectedElements.length !== 1) return;
    let parent = selectedElements[0].parentElement;
    while (parent && parent !== document.body && parent !== document.documentElement) {
      if (!isEditorElement(parent) && isVisible(parent)) {
        pushHistory();
        clearSelection();
        addSelection(parent);
        updateTags();
        return;
      }
      parent = parent.parentElement;
    }
  }

  function navigateToChild() {
    if (selectedElements.length !== 1) return;
    for (const child of selectedElements[0].children) {
      if (!isEditorElement(child) && isVisible(child) && isMeaningful(child)) {
        pushHistory();
        clearSelection();
        addSelection(child);
        updateTags();
        return;
      }
    }
  }


  function handleKeyDown(e) {
    if (isTextEditing(e.target)) return;
    if (isEditorElement(e.target) && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
    const mod = e.metaKey || e.ctrlKey;

    if (e.key === "Escape") {
      if (activePopover) { removeAnnotationPopover(); }
      else if (settingsPopover) { removeSettingsPopover(); }
      else if (closeConfirmEl) { removeCloseConfirm(); }
      else { pushHistory(); clearSelection(); updateTags(); }
      return;
    }
    if (mod && e.key.toLowerCase() === "c" && !e.shiftKey && selectedElements.length > 0) {
      e.preventDefault();
      copyPrompt();
      return;
    }
    if (editMode && mod && e.key.toLowerCase() === "z" && !e.shiftKey) {
      e.preventDefault();
      if (!undoDomChange()) undo();
      return;
    }
    if (editMode && mod && e.key.toLowerCase() === "z" && e.shiftKey) {
      e.preventDefault();
      redoDomChange();
      return;
    }
    if (editMode && (e.key === "Delete" || e.key === "Backspace") && !mod && selectedElements.length > 0) {
      e.preventDefault();
      deleteSelectedElements();
      return;
    }
    if (e.key === "ArrowUp" && selectedElements.length === 1) {
      e.preventDefault();
      navigateToParent();
      return;
    }
    if (e.key === "ArrowDown" && selectedElements.length === 1) {
      e.preventDefault();
      navigateToChild();
      return;
    }
    if (e.key === " " && !mod && !e.altKey) {
      e.preventDefault();
      togglePaused();
    }
  }

  // ── Direct editing ─────────────────────────────────────────
  function isTextEditing(target) {
    return !!(target && target.closest && target.closest('[data-ai-editor-text-editing="true"]'));
  }

  function handleDoubleClick(e) {
    if (!editMode || isEditorElement(e.target)) return;
    const el = resolveTarget(e.target);
    if (!el || /^(IMG|VIDEO|SVG|CANVAS|INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
    e.preventDefault();
    e.stopPropagation();
    startTextEdit(el);
  }

  function startTextEdit(el) {
    if (textEditState) finishTextEdit();
    const before = createElementSnapshot(el, "manual-text");
    textEditState = { el, before };
    el.setAttribute("data-ai-editor-text-editing", "true");
    el.contentEditable = "true";
    el.spellcheck = true;
    el.focus();
    const finish = () => finishTextEdit();
    el.addEventListener("blur", finish, { once: true });
    el.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); restoreSnapshot(before); finishTextEdit(false); }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); el.blur(); }
    }, { once: true });
  }

  function finishTextEdit(record = true) {
    if (!textEditState) return;
    const { el, before } = textEditState;
    el.contentEditable = "false";
    el.removeAttribute("data-ai-editor-text-editing");
    textEditState = null;
    if (record && el.outerHTML !== before.outerHTML) {
      recordDomChange({ before, after: createElementSnapshot(el, "manual-text") });
    }
    positionAllOverlays();
  }

  function startDirectMove(e, el) {
    if (!editMode) return;
    e.preventDefault(); e.stopPropagation();
    const parent = el.parentElement;
    const layout = parent ? getLayoutMode(parent) : "normal";
    const historyTarget = layout === "normal" ? el : parent;
    const before = createElementSnapshot(historyTarget, `manual-${layout}-move`);
    const startLeft = parseFloat(getComputedStyle(el).left) || 0;
    const startTop = parseFloat(getComputedStyle(el).top) || 0;
    if (layout === "normal" && getComputedStyle(el).position === "static") el.style.position = "relative";
    directManipulation = {
      kind: "move", el, parent, layout, historyTarget, before,
      x: e.clientX, y: e.clientY, startLeft, startTop,
      originalTranslate: el.style.translate || "", drop: null
    };
    document.addEventListener("pointermove", onDirectManipulationMove, true);
    document.addEventListener("pointerup", endDirectManipulation, true);
  }

  function startDirectResize(e, el) {
    if (!editMode) return;
    e.preventDefault(); e.stopPropagation();
    const r = el.getBoundingClientRect();
    directManipulation = { kind: "resize", el, before: createElementSnapshot(el, "manual-resize"), x: e.clientX, y: e.clientY, width: r.width, height: r.height };
    document.addEventListener("pointermove", onDirectManipulationMove, true);
    document.addEventListener("pointerup", endDirectManipulation, true);
  }

  function onDirectManipulationMove(e) {
    if (!directManipulation) return;
    const d = directManipulation;
    if (d.kind === "move") {
      if (d.layout === "normal") {
        d.el.style.left = `${Math.round(d.startLeft + e.clientX - d.x)}px`;
        d.el.style.top = `${Math.round(d.startTop + e.clientY - d.y)}px`;
      } else {
        d.el.style.translate = `${Math.round(e.clientX - d.x)}px ${Math.round(e.clientY - d.y)}px`;
        setLayoutDropTarget(d, findLayoutDropTarget(d.parent, d.el, e.clientX, e.clientY, d.layout));
      }
    } else {
      d.el.style.width = `${Math.max(24, Math.round(d.width + e.clientX - d.x))}px`;
      d.el.style.height = `${Math.max(18, Math.round(d.height + e.clientY - d.y))}px`;
    }
    positionAllOverlays();
  }

  function endDirectManipulation() {
    document.removeEventListener("pointermove", onDirectManipulationMove, true);
    document.removeEventListener("pointerup", endDirectManipulation, true);
    if (!directManipulation) return;
    const d = directManipulation;
    directManipulation = null;
    if (d.kind === "move" && d.layout !== "normal") {
      d.el.style.translate = d.originalTranslate;
      applyLayoutDrop(d);
      clearLayoutDropTarget(d);
    }
    const afterTarget = d.historyTarget || d.el;
    if (afterTarget.outerHTML !== d.before.outerHTML) {
      recordDomChange({
        before: d.before,
        after: createElementSnapshot(afterTarget, `manual-${d.layout || "normal"}-${d.kind}`),
      });
    }
  }

  function getLayoutMode(parent) {
    const display = getComputedStyle(parent).display;
    if (display === "flex" || display === "inline-flex") return "flex";
    if (display === "grid" || display === "inline-grid") return "grid";
    return "normal";
  }

  function layoutChildren(parent, moving) {
    return Array.from(parent.children).filter((child) => child !== moving && !isEditorElement(child) && isVisible(child));
  }

  function findLayoutDropTarget(parent, moving, x, y, layout) {
    const candidates = layoutChildren(parent, moving);
    if (!candidates.length) return null;
    const style = getComputedStyle(parent);
    if (layout === "flex") {
      const horizontal = !style.flexDirection.startsWith("column");
      let closest = null;
      let distance = Infinity;
      for (const el of candidates) {
        const r = el.getBoundingClientRect();
        const center = horizontal ? r.left + r.width / 2 : r.top + r.height / 2;
        const point = horizontal ? x : y;
        const nextDistance = Math.abs(point - center);
        if (nextDistance < distance) { closest = { el, before: point < center }; distance = nextDistance; }
      }
      return closest;
    }
    let closest = null;
    let distance = Infinity;
    for (const el of candidates) {
      const r = el.getBoundingClientRect();
      const d = Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2));
      if (d < distance) {
        closest = { el, before: y < r.top + r.height / 2 || (y <= r.bottom && x < r.left + r.width / 2) };
        distance = d;
      }
    }
    return closest;
  }

  function setLayoutDropTarget(state, drop) {
    if (state.drop && (!drop || state.drop.el !== drop.el)) state.drop.el.removeAttribute("data-ai-editor-drop-target");
    state.drop = drop;
    if (drop) drop.el.setAttribute("data-ai-editor-drop-target", "true");
  }

  function clearLayoutDropTarget(state) {
    if (state.drop) state.drop.el.removeAttribute("data-ai-editor-drop-target");
    state.drop = null;
  }

  function hasExplicitGridPlacement(el) {
    const style = getComputedStyle(el);
    return (style.gridColumnStart && style.gridColumnStart !== "auto") || (style.gridRowStart && style.gridRowStart !== "auto");
  }

  function applyLayoutDrop(state) {
    if (!state.drop || !state.parent) return;
    const target = state.drop.el;
    if (state.layout === "grid" && hasExplicitGridPlacement(state.el) && hasExplicitGridPlacement(target)) {
      const sourceStyle = getComputedStyle(state.el);
      const targetStyle = getComputedStyle(target);
      const sourceColumn = sourceStyle.gridColumn;
      const sourceRow = sourceStyle.gridRow;
      state.el.style.gridColumn = targetStyle.gridColumn;
      state.el.style.gridRow = targetStyle.gridRow;
      target.style.gridColumn = sourceColumn;
      target.style.gridRow = sourceRow;
      return;
    }
    state.parent.insertBefore(state.el, state.drop.before ? target : target.nextSibling);
  }

  function recordDomChange(change) {
    domHistory.push(change);
    if (domHistory.length > 100) domHistory.shift();
    domRedoStack.length = 0;
  }

  function updateExportRemovalSelectors(entries, shouldTrackRules) {
    for (const entry of entries) {
      const rule = entry.exportRemovalRule;
      if (!rule) continue;
      const key = JSON.stringify(rule);
      if (shouldTrackRules) exportedRemovalRules.set(key, rule);
      else exportedRemovalRules.delete(key);
    }
    window[EXPORT_REMOVALS_KEY] = Array.from(exportedRemovalRules.values());
  }

  function deletableSelections() {
    return selectedElements
      .filter((el) => el && el.isConnected && el !== document.body && el !== document.documentElement)
      .filter((el, _index, elements) => !elements.some((other) => other !== el && other.contains(el)))
      .sort((a, b) => {
        const position = a.compareDocumentPosition(b);
        return position & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      });
  }

  function deleteSelectedElements() {
    if (!editMode) return;
    if (textEditState) finishTextEdit();
    const targets = deletableSelections();
    if (!targets.length) return;

    const entries = targets.map((el) => ({
      ...createElementSnapshot(el, "remove"),
      exportRemovalRule: buildExportRemovalRule(el),
      node: el,
    }));
    clearSelection();
    for (const el of targets) el.remove();

    recordDomChange({ type: "remove", entries });
    updateExportRemovalSelectors(entries, true);
    updateTags();
    showHover(null);
  }

  function restoreSnapshot(snapshot) {
    const current = snapshot.aiId ? byAiId(snapshot.aiId) : document.querySelector(snapshot.selector);
    if (!current) return false;
    const holder = document.createElement("template");
    holder.innerHTML = snapshot.outerHTML;
    const restored = holder.content.firstElementChild;
    if (!restored) return false;
    current.replaceWith(restored);
    assignAiIds(document.body);
    rebindSelections();
    return true;
  }

  function restoreRemovedElements(entries) {
    const restoredByAiId = new Map();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      const parent = entry.parentAiId ? byAiId(entry.parentAiId)
        : entry.parentSelector ? document.querySelector(entry.parentSelector)
        : null;
      if (!parent) continue;
      let restored = entry.node && !entry.node.isConnected ? entry.node : null;
      if (!restored) {
        const holder = document.createElement("template");
        holder.innerHTML = entry.outerHTML;
        restored = holder.content.firstElementChild;
      }
      if (!restored) continue;
      const next = entry.nextSiblingAiId ? byAiId(entry.nextSiblingAiId) : null;
      if (next && next.parentElement === parent) parent.insertBefore(restored, next);
      else parent.appendChild(restored);
      if (entry.aiId) restoredByAiId.set(entry.aiId, restored);
    }
    assignAiIds(document.body);
    return entries.map((entry) => restoredByAiId.get(entry.aiId)).filter(Boolean);
  }

  function reapplyRemoval(entries) {
    let removed = false;
    clearSelection();
    for (const entry of entries) {
      const el = entry.aiId ? byAiId(entry.aiId) : document.querySelector(entry.selector);
      if (!el) continue;
      el.remove();
      removed = true;
    }
    updateTags();
    showHover(null);
    return removed;
  }

  function undoDomChange() {
    const change = domHistory.pop();
    if (!change) return false;
    let restored = false;
    if (change.type === "remove") {
      const restoredElements = restoreRemovedElements(change.entries);
      restored = restoredElements.length > 0;
      if (restored) updateExportRemovalSelectors(change.entries, false);
      clearSelection();
      for (const el of restoredElements) addSelection(el);
      updateTags();
    } else {
      restored = restoreSnapshot(change.before);
    }
    if (restored) domRedoStack.push(change);
    positionAllOverlays();
    return true;
  }

  function redoDomChange() {
    const change = domRedoStack.pop();
    if (!change) return false;
    if (change.type === "remove") {
      if (!reapplyRemoval(change.entries)) return false;
      domHistory.push(change);
      updateExportRemovalSelectors(change.entries, true);
    } else if (restoreSnapshot(change.after)) {
      domHistory.push(change);
    }
    positionAllOverlays();
    return true;
  }

  function togglePaused() {
    paused = !paused;
    showHover(null);
    const dot = chatPanel.querySelector(`.${NS}-status-dot`);
    const label = chatPanel.querySelector(`.${NS}-status-label`);
    if (dot) dot.style.background = paused ? "#888" : "#4ade80";
    if (label) label.textContent = paused ? "已暂停" : "选取中";
  }

  // ── Annotation popover ─────────────────────────────────────
  function showAnnotationPopover(el, btn) {
    removeAnnotationPopover();

    const aiId = el.getAttribute(AI_ID);
    const popover = document.createElement("div");
    popover.className = `${NS}-root ${NS}-annotate-popover`;

    const textarea = document.createElement("textarea");
    textarea.className = `${NS}-annotate-input`;
    textarea.value = annotations.get(aiId) || "";
    textarea.placeholder = "输入该元素的标注\u2026";
    textarea.rows = 2;

    const actions = document.createElement("div");
    actions.className = `${NS}-annotate-actions`;

    const clearNoteBtn = document.createElement("button");
    clearNoteBtn.className = `${NS}-annotate-clear`;
    clearNoteBtn.textContent = "清除";

    const doneBtn = document.createElement("button");
    doneBtn.className = `${NS}-annotate-done`;
    doneBtn.textContent = "完成";

    const save = () => {
      const val = textarea.value.trim();
      if (val) annotations.set(aiId, val);
      else annotations.delete(aiId);
      removeAnnotationPopover();
      positionSelOverlay(el);
    };

    doneBtn.onclick = (e) => { e.stopPropagation(); save(); };
    clearNoteBtn.onclick = (e) => {
      e.stopPropagation();
      annotations.delete(aiId);
      removeAnnotationPopover();
      positionSelOverlay(el);
    };

    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); save(); }
      e.stopPropagation();
    });
    textarea.addEventListener("click", (e) => e.stopPropagation());

    actions.appendChild(clearNoteBtn);
    actions.appendChild(doneBtn);
    popover.appendChild(textarea);
    popover.appendChild(actions);

    const r = btn.getBoundingClientRect();
    popover.style.top = (r.bottom + 6) + "px";
    popover.style.right = Math.max(8, window.innerWidth - r.right) + "px";

    document.body.appendChild(popover);
    activePopover = popover;
    textarea.focus();
  }

  function removeAnnotationPopover() {
    if (activePopover) {
      activePopover.remove();
      activePopover = null;
    }
  }

  // ── Chat panel ─────────────────────────────────────────────
  function createChatPanel() {
    chatPanel = document.createElement("div");
    chatPanel.className = `${NS}-root ${NS}-chat`;
    chatPanel.innerHTML = `
      <div class="${NS}-drag-handle">
        <span class="${NS}-drag-title">
          <span class="${NS}-product-name">HTMLive</span>
          <span class="${NS}-status-dot"></span>
          <span class="${NS}-status-label">选取中</span>
        </span>
        <div class="${NS}-panel-actions">
          <button class="${NS}-panel-btn" data-action="minimize" title="Minimize">
            <svg width="10" height="2" viewBox="0 0 10 2" fill="none">
              <line x1="0" y1="1" x2="10" y2="1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
          </button>
          <button class="${NS}-panel-btn" data-action="close" title="Close">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <line x1="1" y1="1" x2="9" y2="9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              <line x1="9" y1="1" x2="1" y2="9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
          </button>
        </div>
      </div>
      <div class="${NS}-panel-body">
        <div class="${NS}-chat-tags ${NS}-hidden"></div>
        <div class="${NS}-shortcuts">
          <span><kbd>Click</kbd> 选取</span>
          <span><kbd>Shift</kbd> 多选</span>
          <span><kbd>\u2191\u2193</kbd> 导航</span>
          <span><kbd>Space</kbd> 暂停</span>
          <span><kbd>\u2318C</kbd> 复制</span>
          <span><kbd>\u2318Z</kbd> 撤销</span>
          <span><kbd>Del</kbd> 删除</span>
          <span><kbd>Esc</kbd> 清除</span>
        </div>
        <div class="${NS}-editor-actions">
          <button class="${NS}-mode-btn" data-action="edit-mode">进入编辑模式</button>
          <button class="${NS}-style-btn" data-action="style-drawer" disabled>样式</button>
          <button class="${NS}-delete-btn" data-action="delete-selected" title="删除选中元素（Delete / Backspace）" disabled>删除</button>
          <button class="${NS}-export-btn" data-action="export-html">导出 HTML</button>
        </div>
        <div class="${NS}-style-drawer" hidden>
          <div class="${NS}-drawer-title">选中组件样式</div>
          <label class="${NS}-style-field">
            <span>字体颜色</span>
            <input type="color" data-style-prop="color" value="#111111" />
          </label>
          <label class="${NS}-style-field">
            <span>字体大小</span>
            <span class="${NS}-size-control"><input type="number" data-style-prop="font-size" min="8" max="240" step="1" /><em>px</em></span>
          </label>
          <label class="${NS}-style-field">
            <span>字体</span>
            <select data-style-prop="font-family">
              <option value="">沿用页面设置</option>
              <option value="system-ui, sans-serif">系统无衬线</option>
              <option value="Georgia, serif">Georgia 衬线</option>
              <option value="'Courier New', monospace">等宽字体</option>
              <option value="'PingFang SC', 'Microsoft YaHei', sans-serif">中文系统字体</option>
            </select>
          </label>
          <p class="${NS}-drawer-note">更改写入元素的内联样式；⌘/Ctrl + Z 可撤销。</p>
        </div>
        <button class="${NS}-copy-btn" disabled>复制 Prompt</button>
        <div class="${NS}-chat-area"></div>
        <div class="${NS}-input-bar">
          <button class="${NS}-panel-btn" data-action="settings" title="设置">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          </button>
          <input class="${NS}-input" placeholder="输入指令\u2026" />
          <button class="${NS}-send-btn" data-action="send" title="Send to AI">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2L15 22L11 13L2 9L22 2Z"/></svg>
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(chatPanel);

    chatPanel.querySelector(`.${NS}-copy-btn`).onclick = () => copyPrompt();

    chatPanel.querySelector('[data-action="minimize"]').onclick = toggleMinimize;
    chatPanel.querySelector('[data-action="close"]').onclick = destroy;
    chatPanel.querySelector('[data-action="edit-mode"]').onclick = toggleEditMode;
    chatPanel.querySelector('[data-action="style-drawer"]').onclick = toggleStyleDrawer;
    chatPanel.querySelector('[data-action="delete-selected"]').onclick = deleteSelectedElements;
    chatPanel.querySelector('[data-action="export-html"]').onclick = exportCurrentHtml;

    chatPanel.querySelectorAll(`[data-style-prop]`).forEach((input) => {
      input.addEventListener("change", () => applyDrawerStyle(input));
      input.addEventListener("click", (e) => e.stopPropagation());
      input.addEventListener("keydown", (e) => e.stopPropagation());
    });

    chatPanel.querySelector('[data-action="settings"]').onclick = (e) => {
      e.stopPropagation();
      showSettingsPopover(e.currentTarget);
    };

    const chatInput = chatPanel.querySelector(`.${NS}-input`);
    const sendBtn = chatPanel.querySelector('[data-action="send"]');

    sendBtn.onclick = () => handleSend(chatInput);

    chatInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend(chatInput);
      }
      e.stopPropagation();
    });
    chatInput.addEventListener("click", (e) => e.stopPropagation());

    makeDraggable(chatPanel, chatPanel.querySelector(`.${NS}-drag-handle`));
  }

  function toggleEditMode() {
    editMode = !editMode;
    document.documentElement.classList.toggle(`${NS}-edit-mode`, editMode);
    const btn = chatPanel.querySelector('[data-action="edit-mode"]');
    btn.textContent = editMode ? "退出编辑模式" : "进入编辑模式";
    btn.classList.toggle(`${NS}-mode-active`, editMode);
    const label = chatPanel.querySelector(`.${NS}-status-label`);
    if (label) label.textContent = editMode ? "直接编辑" : (paused ? "已暂停" : "选取中");
    updateTags();
    positionAllOverlays();
  }

  function toggleStyleDrawer() {
    if (selectedElements.length !== 1) return;
    styleDrawerOpen = !styleDrawerOpen;
    const drawer = chatPanel.querySelector(`.${NS}-style-drawer`);
    const btn = chatPanel.querySelector('[data-action="style-drawer"]');
    drawer.hidden = !styleDrawerOpen;
    btn.classList.toggle(`${NS}-style-active`, styleDrawerOpen);
    refreshStyleDrawer();
  }

  function refreshStyleDrawer() {
    if (!chatPanel || selectedElements.length !== 1) return;
    const el = selectedElements[0];
    const computed = getComputedStyle(el);
    const drawer = chatPanel.querySelector(`.${NS}-style-drawer`);
    const color = drawer.querySelector('[data-style-prop="color"]');
    const size = drawer.querySelector('[data-style-prop="font-size"]');
    const family = drawer.querySelector('[data-style-prop="font-family"]');
    color.value = cssColorToHex(computed.color) || "#111111";
    size.value = Math.round(parseFloat(computed.fontSize) || 16);
    family.value = el.style.fontFamily || "";
  }

  function cssColorToHex(value) {
    const parts = String(value).match(/\d+/g);
    if (!parts || parts.length < 3) return null;
    return "#" + parts.slice(0, 3).map((p) => Math.max(0, Math.min(255, Number(p))).toString(16).padStart(2, "0")).join("");
  }

  function applyDrawerStyle(input) {
    if (selectedElements.length !== 1) return;
    const el = selectedElements[0];
    const prop = input.dataset.styleProp;
    let value = input.value;
    if (prop === "font-size") {
      const n = Math.max(8, Math.min(240, Number(value) || 16));
      value = `${n}px`;
      input.value = n;
    }
    const before = createElementSnapshot(el, "manual-style");
    if (prop === "font-family" && !value) el.style.removeProperty(prop);
    else el.style.setProperty(prop, value);
    if (el.outerHTML !== before.outerHTML) {
      recordDomChange({ before, after: createElementSnapshot(el, "manual-style") });
    }
    refreshStyleDrawer();
  }

  async function exportCurrentHtml() {
    if (textEditState) finishTextEdit();
    const baseName = (document.title || "edited-page").replace(/[\\/:*?\"<>|]/g, "-").slice(0, 80);
    const fileName = `${baseName || "edited-page"}-edited.html`;
    try {
      const html = buildExportHtml();
      if (window.isSecureContext && typeof window.showSaveFilePicker === "function") {
        const handle = await window.showSaveFilePicker({
          suggestedName: fileName,
          types: [{ description: "HTML 文件", accept: { "text/html": [".html", ".htm"] } }]
        });
        const writable = await handle.createWritable();
        await writable.write(html);
        await writable.close();
        setExportFeedback("已保存");
        return;
      }
      downloadExportHtml(html, fileName);
      setExportFeedback("已下载");
    } catch (err) {
      if (err && err.name === "AbortError") return;
      console.error("HTMLive export failed", err);
      setExportFeedback("导出失败");
    }
  }

  function buildExportHtml() {
    const clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll('[data-ai-editor-style]').forEach((node) => node.remove());
    clone.querySelectorAll([
      `.${NS}-root`, `.${NS}-hover-box`, `.${NS}-sel-box`, `.${NS}-sel-corner`,
      `.${NS}-sel-label`, `.${NS}-annotate-btn`, `.${NS}-edit-handle`, `.${NS}-marquee`
    ].join(",")).forEach((node) => node.remove());
    clone.querySelectorAll(`[${AI_ID}]`).forEach((node) => node.removeAttribute(AI_ID));
    clone.querySelectorAll('[data-ai-editor-text-editing]').forEach((node) => {
      node.removeAttribute('data-ai-editor-text-editing');
      node.removeAttribute('contenteditable');
    });
    clone.classList.remove(`${NS}-edit-mode`);
    appendExportRemovalScript(clone);
    return "<!doctype html>\n" + clone.outerHTML;
  }

  function appendExportRemovalScript(clone) {
    if (!exportedRemovalRules.size) return;
    const body = clone.querySelector("body");
    if (!body) return;
    const rules = JSON.stringify(Array.from(exportedRemovalRules.values())).replace(/</g, "\\u003c");
    const script = document.createElement("script");
    script.setAttribute("data-htmlive-export-removals", "");
    script.textContent = `(() => {
      const rules = ${rules};
      const normalize = (text) => (text || "").replace(/\\s+/g, " ").trim().slice(0, 160);
      const matchingChildren = (parent, tagName) => Array.from(parent.children)
        .filter((child) => child.tagName.toLowerCase() === tagName);
      const matchesIdentity = (node, identity) => {
        for (const [name, value] of Object.entries(identity.attributes || {})) {
          if (node.getAttribute(name) !== value) return false;
        }
        return !identity.text || normalize(node.textContent || node.getAttribute("aria-label")) === identity.text;
      };
      const resolveUniqueChild = (parent, segment) => {
        const matches = matchingChildren(parent, segment.tag)
          .filter((child) => matchesIdentity(child, segment));
        return matches.length === 1 ? matches[0] : null;
      };
      const resolveParent = (root, rule) => {
        let parent = root;
        for (const segment of rule.parentPath || []) {
          parent = resolveUniqueChild(parent, segment);
          if (!parent) return null;
        }
        return parent;
      };
      const removeMatches = () => {
        const targets = new Set();
        for (const rule of rules) {
          try {
            const root = document.querySelector(rule.rootSelector);
            const parent = root && resolveParent(root, rule);
            const node = parent && resolveUniqueChild(parent, rule);
            if (node) targets.add(node);
          } catch (_) {}
        }
        targets.forEach((node) => node.remove());
      };
      removeMatches();
      let pending = false;
      const observer = new MutationObserver(() => {
        if (pending) return;
        pending = true;
        queueMicrotask(() => {
          pending = false;
          observer.disconnect();
          removeMatches();
          observer.observe(document.documentElement, { childList: true, subtree: true });
        });
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    })();`;
    body.appendChild(script);
  }

  function downloadExportHtml(html, fileName) {
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function setExportFeedback(label) {
    const btn = chatPanel && chatPanel.querySelector('[data-action="export-html"]');
    if (!btn) return;
    const old = btn.textContent;
    btn.textContent = label;
    setTimeout(() => { btn.textContent = old; }, 1800);
  }

  const ICON_MINIMIZE = `<svg width="10" height="2" viewBox="0 0 10 2" fill="none"><line x1="0" y1="1" x2="10" y2="1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
  const ICON_EXPAND   = `<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M1 7L5 3L9 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  function toggleMinimize() {
    minimized = !minimized;
    const body = chatPanel.querySelector(`.${NS}-panel-body`);
    const btn  = chatPanel.querySelector('[data-action="minimize"]');
    if (minimized) {
      body.style.display = "none";
      chatPanel.classList.add(`${NS}-minimized`);
      showHover(null);
      btn.innerHTML = ICON_EXPAND;
      btn.title = "Restore";
    } else {
      body.style.display = "";
      chatPanel.classList.remove(`${NS}-minimized`);
      btn.innerHTML = ICON_MINIMIZE;
      btn.title = "Minimize";
    }
  }

  function makeDraggable(panel, handle) {
    let sx, sy, sl, st;
    handle.addEventListener("mousedown", (e) => {
      if (e.target.closest(`.${NS}-panel-btn`)) return;
      e.preventDefault();
      const r = panel.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; sl = r.left; st = r.top;
      const move = (e) => {
        panel.style.left   = sl + e.clientX - sx + "px";
        panel.style.top    = st + e.clientY - sy + "px";
        panel.style.right  = "auto";
        panel.style.bottom = "auto";
      };
      const up = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
  }

  // ── Element label ──────────────────────────────────────────
  function elementLabel(el) {
    if (el.id) return `#${el.id}`;
    if (el.classList.length) return `.${el.classList[0]}`;
    const tag = el.tagName.toLowerCase();
    const text = (el.textContent || "").trim();
    if (text) {
      const preview = text.length > 20 ? text.slice(0, 20) + "\u2026" : text;
      return `${tag} "${preview}"`;
    }
    return `<${tag}>`;
  }

  // ── Tags ───────────────────────────────────────────────────
  function updateTags() {
    const container = chatPanel.querySelector(`.${NS}-chat-tags`);
    const copyBtn = chatPanel.querySelector(`.${NS}-copy-btn`);
    container.innerHTML = "";

    if (selectedElements.length > 0) {
      container.classList.remove(`${NS}-hidden`);
      copyBtn.disabled = false;

      for (let i = 0; i < selectedElements.length; i++) {
        const el = selectedElements[i];
        const aiId = el.getAttribute(AI_ID);
        const tag = document.createElement("span");
        tag.className = `${NS}-tag`;
        const hasNote = annotations.has(aiId);
        tag.innerHTML = `<span class="${NS}-tag-num">${i + 1}</span><span class="${NS}-tag-label">${elementLabel(el)}${hasNote ? ' \u270e' : ''}</span><button class="${NS}-tag-x" data-aiid="${aiId}" title="Remove">\u00d7</button>`;
        container.appendChild(tag);
      }

      container.querySelectorAll(`.${NS}-tag-x`).forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const el = byAiId(btn.dataset.aiid);
          if (el) removeSelection(el);
          updateTags();
        }, true);
      });

      const clearAllBtn = document.createElement("button");
      clearAllBtn.className = `${NS}-tags-action`;
      clearAllBtn.title = "清除全部";
      clearAllBtn.innerHTML = `<svg width="8" height="8" viewBox="0 0 8 8" fill="none"><line x1="1" y1="1" x2="7" y2="7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="7" y1="1" x2="1" y2="7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg> 清除`;
      clearAllBtn.onclick = (e) => { e.stopPropagation(); clearSelection(); updateTags(); };
      container.appendChild(clearAllBtn);
    } else {
      container.classList.add(`${NS}-hidden`);
      copyBtn.disabled = true;
    }
    const styleBtn = chatPanel.querySelector('[data-action="style-drawer"]');
    const deleteBtn = chatPanel.querySelector('[data-action="delete-selected"]');
    if (styleBtn) styleBtn.disabled = selectedElements.length !== 1;
    if (deleteBtn) deleteBtn.disabled = !editMode || selectedElements.length === 0;
    if (selectedElements.length !== 1 && styleDrawerOpen) {
      styleDrawerOpen = false;
      chatPanel.querySelector(`.${NS}-style-drawer`).hidden = true;
      if (styleBtn) styleBtn.classList.remove(`${NS}-style-active`);
    }
    if (styleDrawerOpen) refreshStyleDrawer();
  }

  // ── Copy with button feedback ──────────────────────────────
  let copyTimer = null;
  function showCopyFeedback(msg) {
    const btn = chatPanel.querySelector(`.${NS}-copy-btn`);
    if (copyTimer) clearTimeout(copyTimer);
    btn.classList.add(`${NS}-copy-done`);
    btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg> ${msg}`;
    copyTimer = setTimeout(() => {
      btn.classList.remove(`${NS}-copy-done`);
      btn.textContent = "复制 Prompt";
      copyTimer = null;
    }, 2000);
  }

  function copyPrompt() {
    const text = buildPromptText();
    if (!text) return;
    writeToClipboard(text);
    showCopyFeedback("已复制");
  }

  // ── Prompt building ────────────────────────────────────────
  function buildPromptText(customInstruction) {
    if (selectedElements.length === 0) return "";

    const instruction = customInstruction !== undefined ? customInstruction
      : chatPanel.querySelector(`.${NS}-input`).value.trim();

    const lines = [location.pathname, ""];

    if (instruction) {
      lines.push("Instruction: " + instruction);
      lines.push("");
    }

    selectedElements.forEach((el, i) => {
      const ctx = buildElementContext(el, i + 1);
      lines.push(`${i + 1}. ${elementLabel(el)} <${ctx.tag}>`);
      if (ctx.source)    lines.push(`   source: ${ctx.source}`);
      if (ctx.react)     lines.push(`   react: ${ctx.react}`);
      if (ctx.selector)  lines.push(`   selector: ${ctx.selector}`);
      if (ctx.nearestId) lines.push(`   inside: ${ctx.nearestId}`);
      if (ctx.text)      lines.push(`   text: "${ctx.text}"`);

      const styles = getComputedStyles(el);
      const nonDefault = Object.entries(styles).filter(([_, v]) =>
        v && v !== "none" && v !== "normal" && v !== "auto" && v !== "0px" && v !== "static"
      );
      if (nonDefault.length) {
        lines.push(`   styles: { ${nonDefault.map(([k, v]) => `${k}: ${v}`).join(", ")} }`);
      }

      Object.entries(ctx.dataAttrs).forEach(([k, v]) => lines.push(`   ${k}: ${v}`));
      if (ctx.outerHTML) lines.push(`   html: ${ctx.outerHTML.slice(0, 200)}`);

      const layout = buildLayoutContext(el);
      if (layout) {
        if (Object.keys(layout.layoutProps).length) {
          lines.push(`   parent-layout: ${JSON.stringify(layout.layoutProps)}`);
        }
        if (layout.spacing.length) {
          const spacingStr = layout.spacing.map(s => `${s.label} (${s.dir}: ${s.gap}px)`).join(", ");
          lines.push(`   spacing: ${spacingStr}`);
        }
      }

      const aiId = el.getAttribute(AI_ID);
      const note = annotations.get(aiId);
      if (note) lines.push(`   instruction: ${note}`);
    });

    if (instruction) {
      lines.push("");
      lines.push("Please modify the source files of the above elements to apply the requested changes.");
    }

    return lines.join("\n");
  }

  function writeToClipboard(text) {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0;top:0;left:0";
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    try { document.execCommand("copy"); } catch (_) {}
    ta.remove();
  }

  // ── React debug info (dev mode only) ──────────────────────
  const SKIP_REACT = new Set([
    "ClientPageRoot","LinkComponent","ServerComponent","AppRouter",
    "Router","HotReload","ReactDevOverlay","InnerLayoutRouter",
    "OuterLayoutRouter","RedirectBoundary","NotFoundBoundary",
    "ErrorBoundary","LoadingBoundary","TemplateContext",
    "ScrollAndFocusHandler","RenderFromTemplateContext",
    "PathnameContextProviderAdapter","Hot","Inner","Forward","Root",
  ]);

  function isUserComponent(name) {
    if (!name || name.length < 2) return false;
    if (SKIP_REACT.has(name)) return false;
    if (/^[a-z]/.test(name)) return false;
    if (name.startsWith("_")) return false;
    return true;
  }

  function getReactDebug(el) {
    try {
      const fiberKey = Object.keys(el).find(k =>
        k.startsWith("__reactFiber") || k.startsWith("__reactInternalInstance")
      );
      if (!fiberKey) return {};

      const result = {};
      let f = el[fiberKey];

      let walker = f;
      while (walker) {
        if (walker._debugSource) {
          const s = walker._debugSource;
          const file = s.fileName.replace(/^.*?\/src\//, "src/");
          result.source = `${file}:${s.lineNumber}`;
          break;
        }
        walker = walker.return;
      }

      const components = [];
      walker = f;
      while (walker) {
        if (walker.type && typeof walker.type === "function") {
          const name = walker.type.displayName || walker.type.name;
          if (isUserComponent(name) && !components.includes(name)) {
            components.push(name);
            if (components.length >= 3) break;
          }
        }
        walker = walker.return;
      }
      if (components.length) result.react = components.reverse().join(" \u203a ");

      return result;
    } catch (_) {
      return {};
    }
  }

  function getFallbackContext(el) {
    let node = el.parentElement;
    while (node && node !== document.body) {
      if (node.id) return { nearestId: `#${node.id}` };
      node = node.parentElement;
    }
    return {};
  }

  // ── Element context ────────────────────────────────────────
  function buildElementContext(el, index) {
    const dataAttrs = {};
    for (const attr of el.attributes) {
      if (attr.name.startsWith("data-") && attr.name !== AI_ID) {
        dataAttrs[attr.name] = attr.value;
      }
    }
    const reactInfo = getReactDebug(el);
    const isReact = !!Object.keys(reactInfo).length;
    return {
      index,
      aiId: el.getAttribute(AI_ID),
      selector: buildSelector(el),
      tag: el.tagName.toLowerCase(),
      text: truncate(el.textContent, 80),
      classes: Array.from(el.classList),
      outerHTML: el.outerHTML.slice(0, 200),
      dataAttrs,
      ...reactInfo,
      ...(isReact ? {} : getFallbackContext(el)),
    };
  }

  function buildSelector(el) {
    if (el.id) return `#${el.id}`;
    const parts = [];
    let node = el;
    while (node && node !== document.body && node !== document.documentElement) {
      let seg = node.tagName.toLowerCase();
      if (node.id) { parts.unshift(`#${node.id}`); break; }
      const p = node.parentElement;
      if (p) {
        const s = Array.from(p.children).filter(c => c.tagName === node.tagName);
        if (s.length > 1) seg += `:nth-of-type(${s.indexOf(node) + 1})`;
      }
      parts.unshift(seg);
      node = node.parentElement;
    }
    return parts.join(" > ");
  }

  function truncate(s, max) {
    if (!s) return "";
    s = s.replace(/\s+/g, " ").trim();
    return s.length > max ? s.slice(0, max) + "\u2026" : s;
  }

  // ── Layout context (parent + sibling spacing) ─────────────
  const LAYOUT_PROPS = [
    "display", "flex-direction", "flex-wrap", "gap",
    "justify-content", "align-items", "position",
  ];

  function buildLayoutContext(el) {
    const parent = el.parentElement;
    if (!parent || parent === document.body || parent === document.documentElement) return null;

    const ps = getComputedStyle(parent);
    const layoutProps = {};
    for (const key of LAYOUT_PROPS) {
      const val = ps.getPropertyValue(key);
      if (val && val !== "normal" && val !== "none" && val !== "static") {
        layoutProps[key] = val;
      }
    }

    const rect = el.getBoundingClientRect();
    const children = Array.from(parent.children).filter(c => !isEditorElement(c) && isVisible(c));
    const idx = children.indexOf(el);
    const spacing = [];

    // previous sibling
    if (idx > 0) {
      const prev = children[idx - 1];
      const pr = prev.getBoundingClientRect();
      const gapH = Math.round(rect.left - pr.right);
      const gapV = Math.round(rect.top - pr.bottom);
      spacing.push({ dir: Math.abs(gapH) <= Math.abs(gapV) ? "left" : "above", label: elementLabel(prev), gap: Math.abs(gapH) <= Math.abs(gapV) ? gapH : gapV });
    }
    // next sibling
    if (idx >= 0 && idx < children.length - 1) {
      const next = children[idx + 1];
      const nr = next.getBoundingClientRect();
      const gapH = Math.round(nr.left - rect.right);
      const gapV = Math.round(nr.top - rect.bottom);
      spacing.push({ dir: Math.abs(gapH) <= Math.abs(gapV) ? "right" : "below", label: elementLabel(next), gap: Math.abs(gapH) <= Math.abs(gapV) ? gapH : gapV });
    }

    return { layoutProps, spacing };
  }

  // ── Computed styles for prompt ──────────────────────────────
  const COMPUTED_STYLE_PROPS = [
    "display", "position", "flex-direction", "align-items", "justify-content",
    "flex-wrap", "gap", "z-index", "padding", "margin", "width", "height",
    "color", "font-size", "font-weight", "text-align", "line-height",
    "background", "background-color", "border", "border-radius",
    "box-shadow", "opacity", "transform", "overflow",
  ];

  function getComputedStyles(el) {
    const s = getComputedStyle(el);
    const out = {};
    for (const prop of COMPUTED_STYLE_PROPS) {
      const val = s.getPropertyValue(prop);
      if (val) out[prop] = val;
    }
    return out;
  }

  // ── Settings ────────────────────────────────────────────────
  const SETTINGS_KEYS = {
    endpoint: "ai-editor-endpoint",
    apikey: "ai-editor-apikey",
    model: "ai-editor-model",
  };

  function loadSettings() {
    return {
      endpoint: localStorage.getItem(SETTINGS_KEYS.endpoint) || "",
      apikey: localStorage.getItem(SETTINGS_KEYS.apikey) || "",
      model: localStorage.getItem(SETTINGS_KEYS.model) || "",
    };
  }

  function saveSettings(settings) {
    localStorage.setItem(SETTINGS_KEYS.endpoint, settings.endpoint);
    localStorage.setItem(SETTINGS_KEYS.apikey, settings.apikey);
    localStorage.setItem(SETTINGS_KEYS.model, settings.model);
  }

  function isConfigured() {
    const s = loadSettings();
    return s.endpoint && s.model;
  }

  function showSettingsPopover(anchorEl) {
    removeSettingsPopover();
    const settings = loadSettings();
    const popover = document.createElement("div");
    popover.className = `${NS}-root ${NS}-settings-popover`;

    const fields = [
      { key: "endpoint", label: "API Base URL", placeholder: "https://coding.dashscope.aliyuncs.com/v1", value: settings.endpoint },
      { key: "apikey", label: "API Key", placeholder: "sk-...", value: settings.apikey, type: "password" },
      { key: "model", label: "模型", placeholder: "gpt-4o", value: settings.model },
    ];

    const inputs = {};
    for (const f of fields) {
      const wrap = document.createElement("div");
      wrap.className = `${NS}-settings-field`;
      const label = document.createElement("label");
      label.className = `${NS}-settings-label`;
      label.textContent = f.label;
      const input = document.createElement("input");
      input.className = `${NS}-settings-input`;
      input.placeholder = f.placeholder;
      input.value = f.value;
      if (f.type) input.type = f.type;
      inputs[f.key] = input;
      wrap.appendChild(label);
      wrap.appendChild(input);
      popover.appendChild(wrap);
    }

    const saveBtn = document.createElement("button");
    saveBtn.className = `${NS}-settings-save`;
    saveBtn.textContent = "保存";
    saveBtn.onclick = (e) => {
      e.stopPropagation();
      saveSettings({
        endpoint: inputs.endpoint.value.trim(),
        apikey: inputs.apikey.value.trim(),
        model: inputs.model.value.trim(),
      });
      removeSettingsPopover();
    };
    popover.appendChild(saveBtn);

    popover.addEventListener("click", (e) => e.stopPropagation());
    popover.addEventListener("keydown", (e) => e.stopPropagation());

    const anchorRect = anchorEl.getBoundingClientRect();
    const popoverHeight = 200;
    popover.style.top = Math.max(8, anchorRect.top - popoverHeight) + "px";
    popover.style.right = Math.max(8, window.innerWidth - anchorRect.right) + "px";

    document.body.appendChild(popover);
    settingsPopover = popover;
    inputs.endpoint.focus();
  }

  function removeSettingsPopover() {
    if (settingsPopover) {
      settingsPopover.remove();
      settingsPopover = null;
    }
  }

  // ── Chat messages ───────────────────────────────────────────
  function getChatArea() {
    return chatPanel.querySelector(`.${NS}-chat-area`);
  }

  function addMessageBubble(type, text) {
    const area = getChatArea();
    const bubble = document.createElement("div");
    bubble.className = `${NS}-msg ${NS}-msg-${type}`;
    bubble.textContent = text;
    area.appendChild(bubble);
    area.scrollTop = area.scrollHeight;
    return bubble;
  }

  function createStreamingBubble() {
    const area = getChatArea();
    const bubble = document.createElement("div");
    bubble.className = `${NS}-msg ${NS}-msg-ai`;
    area.appendChild(bubble);
    return bubble;
  }

  // ── API Client ──────────────────────────────────────────────
  async function streamChatCompletion(messages, onChunk, onDone, onError) {
    const settings = loadSettings();
    if (!settings.endpoint || !settings.model) {
      onError("请先配置 API");
      return;
    }

    const headers = { "Content-Type": "application/json" };
    if (settings.apikey) headers["Authorization"] = `Bearer ${settings.apikey}`;

    const url = settings.endpoint.replace(/\/+$/, "") + "/chat/completions";
    const controller = new AbortController();
    activeAbortController = controller;

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: settings.model, messages, stream: true }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        onError(`API error ${resp.status}: ${body.slice(0, 100)}`);
        activeAbortController = null;
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let fullContent = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;
          const data = trimmed.slice(6);
          if (data === "[DONE]") {
            activeAbortController = null;
            onDone(fullContent);
            return;
          }

          try {
            const json = JSON.parse(data);
            const delta = json.choices && json.choices[0] && json.choices[0].delta && json.choices[0].delta.content;
            if (delta) {
              fullContent += delta;
              onChunk(delta, fullContent);
            }
          } catch (_) { /* skip malformed lines */ }
        }
      }
      activeAbortController = null;
      onDone(fullContent);
    } catch (err) {
      activeAbortController = null;
      if (err.name === "AbortError") {
        onError("响应已中断");
      } else {
        onError(err.message || "网络错误");
      }
    }
  }

  function abortStream() {
    if (activeAbortController) {
      activeAbortController.abort();
      activeAbortController = null;
    }
  }

  // ── System prompt builder ───────────────────────────────────
  function buildSystemPrompt() {
    const instruction = [
      "You are a web UI modification assistant. The user selects elements on a page and tells you how to change them.",
      "Return modifications in this format \u2014 a JSON code block:",
      "```json",
      '[{"selector": "CSS selector", "action": "style|html|attr|move|remove", "style": {...}, "html": "...", "attr": {"name": "...", "value": "..."}, "position": "before|after", "target": "CSS selector", "targetAiId": "el-0", "aiId": "el-0"}]',
      "```",
      "",
      "Supported actions:",
      "- style: apply CSS properties (style field is a CSS property object)",
      "- html: replace inner HTML",
      "- attr: set an attribute (attr field is {name, value})",
      "- move: move element before/after a sibling (requires position: \"before\"|\"after\" and target: CSS selector or targetAiId)",
      "- remove: remove the element",
      "",
      "You may include a brief explanation before or after the JSON block. Return ONLY the changes needed, not the full page.",
    ].join("\n");

    if (selectedElements.length === 0) return instruction;

    const ctx = selectedElements.map((el, i) => {
      const aiId = el.getAttribute(AI_ID);
      const lines = [
        `${i + 1}. ${elementLabel(el)} <${el.tagName.toLowerCase()}>`,
        `   aiId: ${aiId}`,
        `   selector: ${buildSelector(el)}`,
        `   html: ${el.outerHTML.slice(0, 200)}`,
        `   computed: ${JSON.stringify(getComputedStyles(el))}`,
      ];
      const layout = buildLayoutContext(el);
      if (layout) {
        if (Object.keys(layout.layoutProps).length) {
          lines.push(`   parent-layout: ${JSON.stringify(layout.layoutProps)}`);
        }
        if (layout.spacing.length) {
          const spacingStr = layout.spacing.map(s => `${s.label} (${s.dir}: ${s.gap}px)`).join(", ");
          lines.push(`   spacing: ${spacingStr}`);
        }
      }
      const note = annotations.get(aiId);
      if (note) lines.push(`   instruction: ${note}`);
      return lines.join("\n");
    }).join("\n\n");

    return instruction + "\n\nCurrently selected elements:\n" + ctx;
  }

  // ── Chat send flow ──────────────────────────────────────────
  function handleSend(inputEl) {
    if (isStreaming) return;
    const text = inputEl.value.trim();
    if (!text) return;

    if (!isConfigured()) {
      showSettingsPopover(chatPanel.querySelector('[data-action="settings"]'));
      return;
    }

    inputEl.value = "";
    inputEl.placeholder = "等待中\u2026";
    addMessageBubble("user", text);
    chatMessages.push({ role: "user", content: text });

    const sendBtn = chatPanel.querySelector('[data-action="send"]');
    sendBtn.disabled = true;
    isStreaming = true;

    const system = { role: "system", content: buildSystemPrompt() };
    const messages = [system, { role: "user", content: text }];
    const aiBubble = createStreamingBubble();
    aiBubble._userInstruction = text;

    streamChatCompletion(
      messages,
      (chunk, full) => { aiBubble.textContent = full; getChatArea().scrollTop = getChatArea().scrollHeight; },
      (fullContent) => {
        chatMessages.push({ role: "assistant", content: fullContent });
        const { displayText, mods } = parseResponse(fullContent);
        if (mods) {
          applyModifications(mods, aiBubble, displayText);
        } else {
          aiBubble.textContent = displayText || "未检测到修改。";
        }
        isStreaming = false;
        sendBtn.disabled = false;
        inputEl.placeholder = "输入指令\u2026";
      },
      (err) => {
        aiBubble.className = `${NS}-msg ${NS}-msg-error`;
        aiBubble.textContent = err;
        isStreaming = false;
        sendBtn.disabled = false;
        inputEl.placeholder = "输入指令\u2026";
      }
    );
  }

  // ── Response parser ─────────────────────────────────────────
  function parseResponse(text) {
    const jsonBlockRegex = /```json\s*\n?([\s\S]*?)\n?\s*```/g;
    let displayText = text;
    let match;
    let mods = null;

    while ((match = jsonBlockRegex.exec(text)) !== null) {
      displayText = displayText.replace(match[0], "");
      if (!mods) {
        try { mods = JSON.parse(match[1].trim()); } catch (_) { /* try next block */ }
      }
    }

    displayText = displayText.trim();
    if (mods && mods.length > 0) {
      displayText = displayText ? displayText + "\n已应用修改。" : "已应用修改。";
    }

    return { displayText, mods };
  }

  // ── Modification applier ────────────────────────────────────
  function locateElement(item) {
    if (item.aiId) {
      const el = byAiId(item.aiId);
      if (el) return el;
    }
    if (item.selector) {
      try { return document.querySelector(item.selector); } catch (_) { return null; }
    }
    return null;
  }

  function camelToKebab(s) {
    return s.replace(/([A-Z])/g, "-$1").toLowerCase();
  }

  function createElementSnapshot(el, action) {
    const parent = el.parentElement;
    const next = el.nextElementSibling;
    return {
      aiId: el.getAttribute(AI_ID),
      selector: buildSelector(el),
      outerHTML: el.outerHTML,
      parentAiId: parent ? parent.getAttribute(AI_ID) : null,
      parentSelector: parent ? buildSelector(parent) : null,
      nextSiblingAiId: next ? next.getAttribute(AI_ID) : null,
      action,
    };
  }

  function buildExportRemovalRule(el) {
    const parent = el.parentElement;
    let root = parent;
    while (root && root !== document.body && !root.id) root = root.parentElement;
    const rootSelector = root && root.id ? `#${CSS.escape(root.id)}` : "body";
    const pathRoot = root || document.body;
    const parentPath = [];
    let pathNode = parent;
    while (pathNode && pathNode !== pathRoot) {
      const identity = buildExportRemovalIdentity(pathNode);
      if (!identity) return null;
      parentPath.unshift(identity);
      pathNode = pathNode.parentElement;
    }
    if (pathNode !== pathRoot) return null;
    const identity = buildExportRemovalIdentity(el);
    if (!identity) return null;
    return { rootSelector, parentPath, ...identity };
  }

  function buildExportRemovalIdentity(el) {
    const siblings = Array.from(el.parentElement.children)
      .filter((sibling) => sibling.tagName === el.tagName);
    const attributes = {};
    for (const attribute of Array.from(el.attributes)) {
      if ((attribute.name.startsWith("data-") && attribute.name !== AI_ID) || attribute.name === "aria-label") {
        attributes[attribute.name] = attribute.value;
      }
    }
    const attributeEntries = Object.entries(attributes);
    const attributeMatches = (candidate) => attributeEntries.every(
      ([name, value]) => candidate.getAttribute(name) === value
    );
    if (attributeEntries.length && siblings.filter(attributeMatches).length === 1) {
      return { tag: el.tagName.toLowerCase(), attributes, text: "" };
    }
    const heading = el.querySelector("h1, h2, h3, h4, h5, h6");
    const text = normalizeExportText(
      heading ? heading.textContent : (el.getAttribute("aria-label") || el.textContent)
    );
    if (!text) return null;
    const matchingText = siblings.filter((candidate) => {
      if (!attributeMatches(candidate)) return false;
      const candidateHeading = candidate.querySelector("h1, h2, h3, h4, h5, h6");
      return normalizeExportText(
        candidateHeading ? candidateHeading.textContent : (candidate.getAttribute("aria-label") || candidate.textContent)
      ) === text;
    });
    if (matchingText.length !== 1) return null;
    return { tag: el.tagName.toLowerCase(), attributes, text };
  }

  function normalizeExportText(text) {
    return (text || "").replace(/\s+/g, " ").trim().slice(0, 160);
  }

  function applyModifications(mods, aiBubble, displayText) {
    const snapshot = {
      snapshotId: snapshotIdCounter++,
      entries: [],
      messageEl: aiBubble,
    };

    for (const item of mods) {
      const el = locateElement(item);
      if (!el) continue;

      const entry = createElementSnapshot(el, item.action);
      snapshot.entries.push(entry);

      switch (item.action) {
        case "style":
          if (item.style) {
            for (const [key, val] of Object.entries(item.style)) {
              el.style.setProperty(camelToKebab(key), String(val));
            }
          }
          break;
        case "html":
          el.innerHTML = item.html;
          assignAiIds(el);
          break;
        case "attr":
          if (item.attr) el.setAttribute(item.attr.name, item.attr.value);
          break;
        case "move": {
          const targetEl = item.targetAiId ? byAiId(item.targetAiId)
            : item.target ? document.querySelector(item.target)
            : null;
          if (targetEl && targetEl.parentElement) {
            if (item.position === "before") targetEl.parentElement.insertBefore(el, targetEl);
            else targetEl.parentElement.insertBefore(el, targetEl.nextSibling);
          }
          break;
        }
        case "remove":
          el.remove();
          break;
      }
    }

    rebindSelections();
    positionAllOverlays();

    snapshotStack.push(snapshot);

    aiBubble.textContent = displayText || "已应用修改。";

    const actions = document.createElement("div");
    actions.className = `${NS}-msg-actions`;

    const applyBtn = document.createElement("button");
    applyBtn.className = `${NS}-msg-undo`;
    applyBtn.textContent = "应用";
    applyBtn.onclick = (e) => {
      e.stopPropagation();
      const instruction = aiBubble._userInstruction || "";
      const prompt = buildPromptText(instruction);
      if (prompt) {
        writeToClipboard(prompt);
        applyBtn.textContent = "\u2713 已复制";
        setTimeout(() => { applyBtn.textContent = "应用"; }, 2000);
      }
    };

    const undoBtn = document.createElement("button");
    undoBtn.className = `${NS}-msg-undo`;
    undoBtn.textContent = "撤销";
    undoBtn.onclick = (e) => {
      e.stopPropagation();
      undoSnapshot(snapshot);
    };

    actions.appendChild(applyBtn);
    actions.appendChild(undoBtn);
    aiBubble.appendChild(actions);
  }

  function rebindSelections() {
    const rebound = [];
    for (const el of selectedElements) {
      const aiId = el.getAttribute(AI_ID);
      if (aiId) {
        const fresh = byAiId(aiId);
        if (fresh) {
          rebound.push(fresh);
          continue;
        }
      }
      if (aiId) destroySelOverlay(aiId);
    }
    selectedElements = rebound;
    for (const el of selectedElements) {
      const aiId = el.getAttribute(AI_ID);
      if (!selOverlays.has(aiId)) createSelOverlay(el);
    }
  }

  function undoSnapshot(snapshot) {
    for (let i = snapshot.entries.length - 1; i >= 0; i--) {
      const entry = snapshot.entries[i];

      if (entry.action === "remove") {
        const parent = entry.parentAiId ? byAiId(entry.parentAiId)
          : entry.parentSelector ? document.querySelector(entry.parentSelector)
          : null;
        if (!parent) continue;

        const tmp = document.createElement("div");
        tmp.innerHTML = entry.outerHTML;
        const restored = tmp.firstElementChild;
        if (!restored) continue;

        const next = entry.nextSiblingAiId ? byAiId(entry.nextSiblingAiId) : null;
        if (next) parent.insertBefore(restored, next);
        else parent.appendChild(restored);
      } else {
        const el = entry.aiId ? byAiId(entry.aiId)
          : document.querySelector(entry.selector);
        if (!el) continue;
        const tmp = document.createElement("div");
        tmp.innerHTML = entry.outerHTML;
        const restored = tmp.firstElementChild;
        if (!restored) continue;
        el.replaceWith(restored);
      }
    }

    assignAiIds(document.body);
    rebindSelections();
    positionAllOverlays();

    snapshot.messageEl.classList.add(`${NS}-msg-undone`);
    snapshot.messageEl.textContent = "已撤销。";

    const idx = snapshotStack.indexOf(snapshot);
    if (idx >= 0) snapshotStack.splice(idx, 1);
  }

  // ── Boot ───────────────────────────────────────────────────
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
