import { chooseTargetCandidate } from "./targetMatching";
import { findNormalizedTextSpan } from "../normalizedText";
import type { WebviewToHostMessage, ReviewWebviewState } from '../webviewMessages';
import { readHostMessage } from '../webviewMessages';
import type { ReviewThread } from '../types';
import type { MarkdownTableData, MarkdownTableBlock, TableAlignment } from '../tableEdits';

function isPresent<T>(value: T | null | undefined): value is T { return Boolean(value); }

function requiredElement<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error('Missing review control: ' + id);
  return element as T;
}

type LineRange = { lineStart: number; lineEnd: number };
type CommentEdit = { threadId: string; revision?: number; originalComment: string };
type BlockEdit = { originalHtml: string; originalRawMarkdown: string } & (
  | ({ mode: 'edit'; intent: string } & LineRange)
  | { mode: 'insert'; afterLine: number });
type MermaidEdit = LineRange & { originalSource: string };
type TableEdit = LineRange & { rowSources: Array<number | null>; columnSources: Array<number | null>; originalSignature: string };
type TextMatch = { node: Text; rawIndex: number; matchLength: number; occurrenceIndex: number; element: HTMLElement };
// Legacy persisted draft data is validated before reusing its target and sanitized before rendering.
// It remains a migration boundary while current actions use the typed message contract.
type DraftData = Record<string, any>;
type DraftSession = { submit(message: WebviewToHostMessage): boolean; collect(key?: string | Event): void; refresh(): void; canOpen(key: string): boolean };
type SaveControl = HTMLElement & { disabled: boolean };

const vscode = acquireVsCodeApi();
const state = window.reviewInitialState;
const trusted = state.trusted !== false;
const canEditMarkdown = state.canEditMarkdown !== false && trusted;
const markdownTables = Array.isArray(state.tables) ? state.tables : [];
const sourceLines = Array.isArray(state.sourceLines) ? state.sourceLines : [];
const sourceLineEnding = typeof state.sourceLineEnding === 'string' ? state.sourceLineEnding : '\n';
const documentVersion = Number(state.documentVersion);
let draftSession: DraftSession | undefined;
let activeCommentEdit: CommentEdit | undefined;
function postReviewMessage(message: WebviewToHostMessage) {
  if (!trusted && message.type !== 'refreshPreview' && message.type !== 'webviewReady') return;
  if (draftSession?.submit(message)) return;
  vscode.postMessage({ ...message, documentVersion });
}
let restoreState = state.restoreState || {};
const savedState = vscode.getState();
const viewState: { sidebarCollapsed?: boolean; editDocument?: boolean; scrollY?: number; sidebarScrollTop?: number; focusId?: string } = savedState?.documentUri === state.documentUri ? { ...savedState.view } : {};
let overlayTrigger: HTMLElement | undefined;
const markdownBody = requiredElement<HTMLElement>('markdown-body');
const selectionPopover = requiredElement<HTMLElement>('selection-popover');
const selectionCommentButton = requiredElement<HTMLButtonElement>('selection-comment');
const commentComposer = requiredElement<HTMLFormElement>('comment-composer');
const commentBody = requiredElement<HTMLTextAreaElement>('comment-body');
const commentQualityWarning = requiredElement<HTMLElement>('comment-quality-warning');
const commentCancel = requiredElement<HTMLButtonElement>('comment-cancel');
const commentOverlay = requiredElement<HTMLElement>('comment-overlay');
const blockEditor = requiredElement<HTMLFormElement>('block-editor');
const blockEditorTitle = requiredElement<HTMLElement>('block-editor-title');
const blockEditorLines = requiredElement<HTMLElement>('block-editor-lines');
const blockEditorSurface = requiredElement<HTMLElement>('block-editor-surface');
const blockEditorRaw = requiredElement<HTMLTextAreaElement>('block-editor-raw');
const blockEditorRawToggle = requiredElement<HTMLButtonElement>('block-editor-raw-toggle');
const blockEditorStatus = requiredElement<HTMLElement>('block-editor-status');
const blockEditorCancel = requiredElement<HTMLButtonElement>('block-editor-cancel');
const blockEditorDelete = requiredElement<HTMLButtonElement>('block-editor-delete');
const blockEditorSubmit = requiredElement<HTMLButtonElement>('block-editor-submit');
const mermaidEditor = requiredElement<HTMLFormElement>('mermaid-editor');
const mermaidEditorLines = requiredElement<HTMLElement>('mermaid-editor-lines');
const mermaidEditorSource = requiredElement<HTMLTextAreaElement>('mermaid-editor-source');
const mermaidEditorCancel = requiredElement<HTMLButtonElement>('mermaid-editor-cancel');
const tableEditor = requiredElement<HTMLFormElement>('table-editor');
const tableEditorLines = requiredElement<HTMLElement>('table-editor-lines');
const tableEditorGrid = requiredElement<HTMLElement>('table-editor-grid');
const tableEditorCancel = requiredElement<HTMLButtonElement>('table-editor-cancel');
const tableEditorAddRow = requiredElement<HTMLButtonElement>('table-editor-add-row');
const tableEditorAddColumn = requiredElement<HTMLButtonElement>('table-editor-add-column');
let activeSelectionText = '';
let activeSelectionOccurrence = 0;
let activeSourceLine: number | undefined;
let activeSourceLineEnd: number | undefined;
let activeSelectionRect: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'> | null = null;
let activeSelectionRange: Range | null = null;
let selectionTimer: number | undefined;
let activeBlockEdit: BlockEdit | undefined;
let pendingBlockRawConversionId = '';
let pendingBlockRawConversionHtml = '';
let activeMermaidEdit: MermaidEdit | undefined;
let activeTableEdit: TableEdit | undefined;
const draftSelectionHighlightLayer = document.createElement('div');
draftSelectionHighlightLayer.className = 'draft-selection-highlight-layer';
draftSelectionHighlightLayer.hidden = true;
document.body.appendChild(draftSelectionHighlightLayer);

document.addEventListener('selectionchange', () => {
  scheduleSelectionComposer(false);
});

markdownBody.addEventListener('pointerup', () => {
  scheduleSelectionComposer(true);
});

markdownBody.addEventListener('keyup', () => {
  scheduleSelectionComposer(false);
});

window.addEventListener('scroll', () => {
  renderDraftSelectionFallbackHighlight();
}, true);

window.addEventListener('resize', () => {
  renderDraftSelectionFallbackHighlight();
  document.querySelectorAll<HTMLElement>('.selection-popover, .comment-composer, .comment-overlay, .block-editor, .mermaid-editor, .table-editor')
    .forEach(element => { if (element.style.display === 'block') clampFloatingElement(element); });
});

window.addEventListener('message', (event) => {
  const message = readHostMessage(event.data);
  if (!message) return;

  if (message.type !== 'convertedMarkdownBlockHtml'
    || message.requestId !== pendingBlockRawConversionId) {
    return;
  }

  pendingBlockRawConversionId = '';
  blockEditorRawToggle.disabled = false;
  if (message.error) {
    setBlockEditorStatus(String(message.error));
    focusActiveBlockEditorInput();
    return;
  }
  if (serializeBlockEditorHtml() !== pendingBlockRawConversionHtml) {
    setBlockEditorStatus('The draft changed during conversion. Try Raw again to include your latest edits.');
    focusActiveBlockEditorInput();
    return;
  }
  blockEditorRaw.value = String(message.rawMarkdown || '');
  setBlockEditorRawMode(true);
  setBlockEditorStatus('');
  focusActiveBlockEditorInput();
});

selectionCommentButton.addEventListener('click', () => {
  openComposer();
});

commentCancel.addEventListener('click', () => {
  hideComposer();
});

blockEditorCancel.addEventListener('click', () => {
  hideBlockEditor();
});

blockEditorDelete.addEventListener('click', () => {
  if (!activeBlockEdit) {
    return;
  }

  if (activeBlockEdit.mode === 'insert') {
    hideBlockEditor();
    return;
  }

  postReviewMessage({
    type: 'deleteMarkdownBlock',
    lineStart: activeBlockEdit.lineStart,
    lineEnd: activeBlockEdit.lineEnd
  });
});

blockEditorRawToggle.addEventListener('click', () => {
  toggleBlockEditorRawMode();
});

mermaidEditorCancel.addEventListener('click', () => {
  hideMermaidEditor();
});

tableEditorCancel.addEventListener('click', () => {
  hideTableEditor();
});

tableEditorAddRow.addEventListener('click', () => {
  const table = readTableEditorData();
  table.rows.push(Array.from({ length: table.headers.length }, () => ''));
  activeTableEdit?.rowSources.push(null);
  renderTableEditorGrid(table);
  focusTableCell(table.rows.length, 0);
});

tableEditorAddColumn.addEventListener('click', () => {
  const table = readTableEditorData();
  table.headers.push('Column ' + (table.headers.length + 1));
  activeTableEdit?.columnSources.push(null);
  table.alignments.push('none');
  table.rows = table.rows.map((row) => [...row, '']);
  renderTableEditorGrid(table);
  focusTableCell(0, table.headers.length - 1);
});

tableEditorGrid.addEventListener('click', (event) => {
  const target = event.target;

  if (!(target instanceof HTMLElement)) {
    return;
  }

  const removeColumnButton = target.closest<HTMLElement>('[data-remove-table-column]');

  if (removeColumnButton) {
    const columnIndex = Number(removeColumnButton.getAttribute('data-column'));
    const table = readTableEditorData();

    if (table.headers.length > 1 && Number.isFinite(columnIndex)) {
      table.headers.splice(columnIndex, 1);
      activeTableEdit?.columnSources.splice(columnIndex, 1);
      table.alignments.splice(columnIndex, 1);
      table.rows = table.rows.map((row) => row.filter((_, index) => index !== columnIndex));
      renderTableEditorGrid(table);
    }

    return;
  }

  const removeRowButton = target.closest<HTMLElement>('[data-remove-table-row]');

  if (removeRowButton) {
    const rowIndex = Number(removeRowButton.getAttribute('data-row'));
    const table = readTableEditorData();

    if (Number.isFinite(rowIndex)) {
      table.rows.splice(rowIndex, 1);
      activeTableEdit?.rowSources.splice(rowIndex, 1);
      renderTableEditorGrid(table);
    }
  }
});

blockEditor.addEventListener('submit', (event) => {
  event.preventDefault();

  if (!activeBlockEdit) {
    return;
  }

  const payload = isBlockEditorRawMode()
    ? { rawMarkdown: blockEditorRaw.value }
    : { html: serializeBlockEditorHtml() };

  if (activeBlockEdit.mode === 'insert') {
    postReviewMessage({
      type: 'insertMarkdownBlock',
      afterLine: activeBlockEdit.afterLine,
      ...payload
    });
  } else {
    postReviewMessage({
      type: 'editMarkdownBlock',
      lineStart: activeBlockEdit.lineStart,
      lineEnd: activeBlockEdit.lineEnd,
      intent: activeBlockEdit.intent,
      ...payload
    });
  }
});

mermaidEditor.addEventListener('submit', (event) => {
  event.preventDefault();

  if (!activeMermaidEdit) {
    return;
  }

  postReviewMessage({
    type: 'editMermaidSource',
    lineStart: activeMermaidEdit.lineStart,
    lineEnd: activeMermaidEdit.lineEnd,
    source: mermaidEditorSource.value
  });
});

tableEditor.addEventListener('submit', (event) => {
  event.preventDefault();

  if (!activeTableEdit) {
    return;
  }

  const table = readTableEditorData();
  postReviewMessage({
    type: 'editMarkdownTable',
    lineStart: activeTableEdit.lineStart,
    lineEnd: activeTableEdit.lineEnd,
    headers: table.headers,
    alignments: table.alignments,
    rows: table.rows,
    tableSourceMapping: { rowSources: activeTableEdit.rowSources, columnSources: activeTableEdit.columnSources }
  });
});

blockEditor.addEventListener('click', (event) => {
  const target = event.target;

  if (!(target instanceof HTMLElement)) {
    return;
  }

  const inlineButton = target.closest<HTMLElement>('[data-inline-format]');
  const blockButton = target.closest<HTMLElement>('[data-format-block]');

  if (inlineButton) {
    event.preventDefault();
    blockEditorSurface.focus();
    applyInlineFormat(inlineButton.getAttribute('data-inline-format') || '');
    return;
  }

  if (blockButton) {
    event.preventDefault();
    blockEditorSurface.focus();
    applyBlockFormat(blockButton.getAttribute('data-format-block') || '');
  }
});

blockEditor.addEventListener('mousedown', (event) => {
  const target = event.target;

  if (target instanceof HTMLElement && target.closest<HTMLElement>('.block-editor-toolbar button')) {
    event.preventDefault();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.altKey && event.key === 'Enter' && !isTextEntryTarget(event.target) && captureCurrentSelection()) {
    event.preventDefault();
    openComposer();
    return;
  }
  if (event.key === 'Escape') {
    if (!hideCommentOverlayIfClean()) {
      return;
    }
    hideSelectionPopover();
    hideComposerIfEmpty();
    hideBlockEditorIfClean();
    hideMermaidEditorIfClean();
    hideTableEditorIfClean();
  }

  if (event.key === 'Enter'
    && !event.shiftKey
    && !event.isComposing
    && event.target instanceof HTMLTextAreaElement) {
    const form = event.target.closest<HTMLFormElement>('form');

    if (form === commentComposer) {
      event.preventDefault();
      form.requestSubmit();
      return;
    }
  }

  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && commentComposer.style.display === 'block') {
    event.preventDefault();
    commentComposer.requestSubmit();
  }

  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || isTextEntryTarget(event.target)) {
      return;
    }

    event.preventDefault();
    navigateReviewThread(event.key === 'ArrowRight' ? 1 : -1);
  }
});

commentComposer.addEventListener('submit', (event) => {
  event.preventDefault();
  const body = commentBody.value.trim();

  if (!body || (!activeCommentEdit && !activeSelectionText)) {
    return;
  }

  if (activeCommentEdit) {
    postReviewMessage({ type: 'editComment', threadId: activeCommentEdit.threadId, taskRevision: activeCommentEdit.revision, comment: body });
    return;
  }
  postReviewMessage({
    type: 'addComment',
    anchorText: activeSelectionText,
    anchorOccurrence: activeSelectionOccurrence,
    sourceLine: activeSourceLine,
    sourceLineEnd: activeSourceLineEnd,
    comment: body
  });
  hideSelectionPopover();
});

commentBody.addEventListener('input', () => {
  updateCommentQualityWarning();
});

document.addEventListener('click', (event) => {
  const target = event.target;

  if (!(target instanceof HTMLElement)) {
    return;
  }

  if (target.closest<HTMLElement>('[data-close-comments]')) {
    event.preventDefault();
    hideCommentOverlay();
    return;
  }
  const copyJsonButton = target.closest<HTMLElement>('[data-copy-review-json]');
  if (copyJsonButton) {
    event.preventDefault();
    event.stopPropagation();
    draftSession?.collect();
    postReviewMessage({ type: 'copyReviewJson' });
    return;
  }
  const jumpButton = target.closest<HTMLElement>('[data-jump-thread]');
  if (jumpButton && target.closest<HTMLElement>('#comment-overlay')) {
    event.stopPropagation();
    focusAnchor(jumpButton.closest<HTMLElement>('[data-thread-id]')?.getAttribute('data-thread-id'));
    return;
  }
  const editCommentButton = target.closest<HTMLElement>('[data-edit-comment]');
  if (editCommentButton) {
    event.stopPropagation();
    const thread = findThread(editCommentButton.getAttribute('data-thread-id'));
    if (thread) openCommentEditor(thread);
    return;
  }
  const removeCommentButton = target.closest<HTMLElement>('[data-remove-comment]');
  if (removeCommentButton) {
    event.stopPropagation();
    const thread = findThread(removeCommentButton.getAttribute('data-thread-id'));
    if (thread) postReviewMessage({type:'removeComment',threadId:thread.id,taskRevision:thread.taskRevision,requestId:'remove-'+Date.now()+'-'+Math.random().toString(16).slice(2)});
    return;
  }
  hideComposerIfEmpty(target);

  if (target.closest<HTMLElement>('#block-editor')) {
    return;
  }

  hideBlockEditorIfClean();

  if (target.closest<HTMLElement>('#mermaid-editor')) {
    return;
  }

  hideMermaidEditorIfClean();

  if (target.closest<HTMLElement>('#table-editor')) {
    return;
  }

  hideTableEditorIfClean();

  const tableEditButton = target.closest<HTMLElement>('[data-edit-markdown-table]');

  if (tableEditButton) {
    event.preventDefault();
    event.stopPropagation();
    const wrapper = tableEditButton.closest<HTMLElement>('[data-table-edit-wrapper]');
    const table = wrapper?.querySelector<HTMLElement>('table[data-source-line]');

    if (table) {
      openTableEditor(table);
    }

    return;
  }

  const tableCommentButton = target.closest<HTMLElement>('[data-comment-markdown-table-cell], [data-comment-markdown-table]');

  if (tableCommentButton) {
    event.preventDefault();
    event.stopPropagation();

    if (tableCommentButton.hasAttribute('data-comment-markdown-table-cell')) {
      const cell = tableCommentButton.closest<HTMLElement>('td, th');

      if (cell) {
        openComposerForTableCell(cell);
      }
    } else {
      const wrapper = tableCommentButton.closest<HTMLElement>('[data-table-edit-wrapper]');
      const table = wrapper?.querySelector<HTMLElement>('table[data-source-line]');

      if (table) {
        openComposerForTable(table);
      }
    }

    return;
  }

  const blockAddButton = target.closest<HTMLElement>('[data-add-markdown-block]');

  if (blockAddButton) {
    event.preventDefault();
    event.stopPropagation();
    const block = blockAddButton.closest<HTMLElement>('[data-source-line]');

    if (block) {
      openInsertBlockEditor(block);
    }

    return;
  }

  const blockDeleteButton = target.closest<HTMLElement>('[data-delete-markdown-block]');

  if (blockDeleteButton) {
    event.preventDefault();
    event.stopPropagation();
    const block = blockDeleteButton.closest<HTMLElement>('[data-source-line]');
    const lineRange = block ? getEditableLineRange(block) : undefined;

    if (lineRange) {
      postReviewMessage({
        type: 'deleteMarkdownBlock',
        lineStart: lineRange.lineStart,
        lineEnd: lineRange.lineEnd
      });
    }

    return;
  }

  const blockEditButton = target.closest<HTMLElement>('[data-edit-markdown-block]');

  if (blockEditButton) {
    event.preventDefault();
    event.stopPropagation();
    const block = blockEditButton.closest<HTMLElement>('[data-source-line]');

    if (block) {
      openBlockEditor(block, 'manual_block_edit');
    }

    return;
  }

  const cleanupButton = target.closest<HTMLElement>('[data-cleanup-legacy-metadata], [data-cleanup-stale-anchors]');

  if (cleanupButton) {
    event.preventDefault();
    event.stopPropagation();
    postReviewMessage({
      type: 'cleanupLegacyMetadata'
    });
    return;
  }

  const reviewNavigationButton = target.closest<HTMLElement>('[data-review-nav]');

  if (reviewNavigationButton) {
    event.preventDefault();
    event.stopPropagation();
    navigateReviewThread(reviewNavigationButton.getAttribute('data-review-nav') === 'previous' ? -1 : 1);
    return;
  }

  if (target.closest<HTMLElement>('#comment-overlay')) {
    return;
  }

  const figure = target.closest<HTMLElement>('[data-mermaid-diagram]');

  if (figure) {
    const source = getMermaidSource(figure);

    if (target.matches('[data-mermaid-edit]')) {
      openMermaidEditor(figure, source);
      return;
    }

    if (target.matches('[data-mermaid-feedback]')) {
      openComposerForElementText(figure, source, getSourceLine(figure), getSourceLineEnd(figure));
      return;
    }

    if (target.matches('[data-mermaid-copy]')) {
      postReviewMessage({ type: 'copyText', text: source });
      return;
    }
  }

  const imageFeedbackButton = target.closest<HTMLElement>('[data-image-feedback]');

  if (imageFeedbackButton) {
    event.preventDefault();
    event.stopPropagation();
    const image = imageFeedbackButton.closest<HTMLElement>('[data-markdown-image]');

    if (image) {
      openComposerForElementText(image, getImageReviewAnchor(image), getSourceLine(image), getSourceLineEnd(image));
    }

    return;
  }

  const commentTarget = target.closest<HTMLElement>('.review-badge, .review-anchor, .review-anchor-block, [data-mermaid-diagram].has-review');

  if (commentTarget) {
    const threadIds = getThreadIds(commentTarget);

    if (threadIds.length > 0) {
      event.stopPropagation();
      const sourceElement = target.closest<HTMLElement>('.review-badge') || commentTarget;
      openCommentOverlay(threadIds, sourceElement);
      focusThread(threadIds[0], false);
      return;
    }
  }

  hideCommentOverlayIfClean();
});

let openThreads = state.threads.filter((thread) => thread.status === 'open');
const threadsContainer = requiredElement<HTMLElement>('threads');
const reviewSidebar = requiredElement<HTMLElement>('review-sidebar');

function renderComments() {
threadsContainer.replaceChildren();
if (openThreads.length === 0) {
  threadsContainer.innerHTML = '<p class="empty">Select text in the document to add a comment.</p>';
} else {
  for (const thread of openThreads) {
    const element = document.createElement('section');
    element.className = 'thread ' + sourceClass(thread);
    element.dataset.threadId = thread.id;
    element.title = 'Jump to commented content';
    element.innerHTML = [
      '<blockquote>' + escapeHtml(thread.anchor.text || 'Document') + '</blockquote>',
      '<p>' + escapeHtml(thread.comment) + '</p>',
      renderThreadActions(thread)
    ].join('');

    element.addEventListener('click', (event) => {
      if (event.target instanceof HTMLElement && event.target.closest<HTMLElement>('button, textarea, form')) {
        return;
      }

      focusAnchor(thread.id);
    });

    element.querySelector<HTMLElement>('[data-jump-thread]')?.addEventListener('click', (event) => {
      event.stopPropagation();
      focusAnchor(thread.id);
    });

    threadsContainer.appendChild(element);
  }
}

const locatableOpenThreads = openThreads.filter(shouldAutoLocateThread);
decorateImageReviewBadges(locatableOpenThreads);
decorateReviewAnchors(locatableOpenThreads);
decorateMermaidReviewBadges(locatableOpenThreads);
markMissingAnchors(openThreads);
updateReviewNavigation();
}
renderComments();
setSidebarCollapsed(Boolean(viewState.sidebarCollapsed));
document.querySelectorAll<HTMLElement>('[data-toggle-sidebar]').forEach((button) => {
  button.addEventListener('click', () => {
    setSidebarCollapsed(!reviewSidebar.hidden);
    persistView();
  });
});
decorateEditableMarkdownTables();
setEditDocumentMode(Boolean(viewState.editDocument));
document.querySelector<HTMLElement>('[data-toggle-edit-document]')?.addEventListener('click', () => {
  setEditDocumentMode(!viewState.editDocument);
  persistView();
});
restorePreviewState();

draftSession = (() => {
  const supported = new Set(['addComment', 'editComment', 'editMarkdownBlock', 'insertMarkdownBlock', 'editMermaidSource', 'editMarkdownTable']);
  const stored = vscode.getState?.();
  const drafts: Record<string, DraftData> = stored?.schema === 1 && stored.documentUri === state.documentUri
    && stored.drafts && typeof stored.drafts === 'object' ? stored.drafts : {};
  const pendingForms = new Map<HTMLElement, Array<[SaveControl, boolean, string | null]>>();
  const recovery = document.createElement('section');
  recovery.className = 'draft-recovery';
  recovery.setAttribute('aria-label', 'Recovered drafts');
  markdownBody.before(recovery);
  let restoring = true;

  function keyFor(message: WebviewToHostMessage) {
    if (message.type === 'addComment' || message.type === 'editComment') return 'comment';
    if (message.type === 'editMermaidSource') return 'mermaid';
    if (message.type === 'editMarkdownTable') return 'table';
    return 'block';
  }

  function formFor(key: string) {
    if (key === 'comment') return commentComposer;
    if (key === 'block') return blockEditor;
    if (key === 'mermaid') return mermaidEditor;
    if (key === 'table') return tableEditor;
    return undefined;
  }

  function formsFor(key: string) { return [formFor(key)].filter((form): form is HTMLFormElement => Boolean(form)); }

  function visible(form: HTMLElement | undefined) { return form?.style.display === 'block'; }
  function persist() {
    if (restoring) return;
    vscode.setState?.({ schema: 1, documentUri: state.documentUri, drafts, view: viewState });
  }

  function remember(key: string, data: DraftData | undefined) {
    if (drafts[key]?.requestId || drafts[key]?.recovery) return;
    if (!data) { delete drafts[key]; return; }
    drafts[key] = { ...drafts[key], ...data, fingerprint: state.sourceFingerprint };
  }

  function collect(forceKey?: string | Event) {
    if (restoring) return;
    if (visible(commentComposer)) remember('comment', commentBody.value ? {
      kind: 'comment', text: commentBody.value, edit: activeCommentEdit, anchorText: activeSelectionText,
      anchorOccurrence: activeSelectionOccurrence, sourceLine: activeSourceLine, sourceLineEnd: activeSourceLineEnd
    } : undefined);
    if (visible(blockEditor) && activeBlockEdit) remember('block', isBlockEditorDirty() || forceKey === 'block' ? {
      kind: 'block', edit: activeBlockEdit, html: blockEditorSurface.innerHTML,
      raw: blockEditorRaw.value, rawMode: isBlockEditorRawMode()
    } : undefined);
    if (visible(mermaidEditor) && activeMermaidEdit) remember('mermaid', mermaidEditorSource.value !== activeMermaidEdit.originalSource || forceKey === 'mermaid' ? {
      kind: 'mermaid', edit: activeMermaidEdit, text: mermaidEditorSource.value
    } : undefined);
    if (visible(tableEditor) && activeTableEdit) remember('table', tableEditorSignature() !== activeTableEdit.originalSignature || forceKey === 'table' ? {
      kind: 'table', edit: activeTableEdit, table: readTableEditorData()
    } : undefined);
    persist();
  }

  function status(form: HTMLElement | undefined, text: string) {
    if (!form) return;
    let element = form.querySelector<HTMLElement>('[data-save-status]');
    if (!element) {
      element = document.createElement('p');
      element.setAttribute('data-save-status', '');
      element.setAttribute('role', 'status');
      element.setAttribute('aria-live', 'polite');
      form.appendChild(element);
    }
    element.textContent = text;
  }

  function freeze(form: HTMLElement | undefined, saving: boolean) {
    if (!form) return;
    form.setAttribute('aria-busy', saving ? 'true' : 'false');
    if (saving) {
      if (pendingForms.has(form)) return;
      const controls = Array.from(form.querySelectorAll<SaveControl>('input, textarea, button, select, [contenteditable]'));
      pendingForms.set(form, controls.map(element => [element, element.disabled, element.getAttribute('contenteditable')]));
      controls.forEach(element => {
        if (element.hasAttribute('contenteditable')) element.setAttribute('contenteditable', 'false');
        else element.disabled = true;
      });
    } else {
      for (const [element, disabled, editable] of pendingForms.get(form) || []) {
        if (editable !== null) element.setAttribute('contenteditable', editable);
        else element.disabled = disabled;
      }
      pendingForms.delete(form);
    }
  }

  function clear(key: string, close: boolean) {
    formsFor(key).forEach(form => freeze(form, false));
    delete drafts[key];
    if (close) {
      if (key === 'comment') hideComposer();
      else if (key === 'block') hideBlockEditor();
      else if (key === 'mermaid') hideMermaidEditor();
      else if (key === 'table') hideTableEditor();

    }
    persist();
  }

  function acceptResult(message: { requestId: string; ok: boolean; error?: string }) {
    const key = Object.keys(drafts).find(key => drafts[key]?.requestId === message.requestId);
    if (!key) return;
    if (message.ok) clear(key, true);
    else {
      const draft = drafts[key];
      delete draft.requestId;
      draft.error = String(message.error || 'Not saved. Your draft is kept. Retry when ready.');
      formsFor(key).forEach(form => freeze(form, false));
      delete draft.recovery;
      restoreDraft(key, draft);
      formsFor(key).forEach(form => status(form, draft.error));
      persist();
    }
    showRecovery();
  }

  function submit(message: WebviewToHostMessage) {
    if (!supported.has(message.type)) return false;
    const key = keyFor(message);
    if (drafts[key]?.requestId || drafts[key]?.recovery) return true;
    collect(key);
    if (!drafts[key]) return true;
    const requestId = 'save-' + Date.now() + '-' + Math.random().toString(16).slice(2);
    drafts[key].requestId = requestId;
    delete drafts[key].error;
    persist();
    const forms = formsFor(key);
    forms.forEach(form => { freeze(form, true); status(form, 'Saving…'); });
    vscode.postMessage({ ...message, requestId, documentVersion });
    return true;
  }

  // Persisted HTML is draft data, never executable markup.
  function safeHtml(html: string) {
    const container = document.createElement('div');
    container.innerHTML = String(html || '');
    container.querySelectorAll<HTMLElement>('script, style, iframe, object, embed, link, meta, base, form, input, button').forEach(element => element.remove());
    container.querySelectorAll<HTMLElement>('*').forEach(element => {
      Array.from(element.attributes).forEach(attribute => {
        if (/^on/i.test(attribute.name) || ['srcdoc', 'style', 'id', 'autofocus'].includes(attribute.name)
          || (['href', 'src', 'xlink:href'].includes(attribute.name)
            && /^[a-z][a-z0-9+.-]*:/i.test(attribute.value.trim())
            && !/^(?:https?:|mailto:|data:image\/)/i.test(attribute.value.trim()))) {
          element.removeAttribute(attribute.name);
        }
      });
    });
    return container.innerHTML;
  }

  function restoreDraft(key: string, draft: DraftData) {
    if (!draft || typeof draft !== 'object') { delete drafts[key]; return; }
    const outcome = restoreState.mutationResults?.[draft.requestId];
    if (outcome?.ok) { delete drafts[key]; return; }
    if (outcome) { delete draft.requestId; draft.error = outcome.error; }
    if (draft.requestId) {
      draft.recovery = 'Save confirmation is unavailable. Check the current document or thread before copying this draft to avoid duplicate changes.';
    } else if (draft.kind !== 'reply' && !draft.edit?.threadId && draft.fingerprint !== state.sourceFingerprint) {
      draft.recovery = 'The document changed. Copy your draft, reopen the current target, and review it before saving.';
    }
    if (draft.recovery) return;
    if (draft.kind === 'reply') {
      draft.recovery = 'This is a draft from an earlier reply. Copy it to use as a change request with your external agent.';
    } else if (draft.kind === 'comment') {
      if (draft.edit) {
        const current = findThread(draft.edit.threadId);
        if (!current || current.taskRevision !== draft.edit.revision || current.comment !== draft.edit.originalComment) {
          draft.recovery = 'The change request changed. Copy the draft, confirm the current request, and edit it again.';
          return;
        }
      }
      activeCommentEdit = draft.edit;
      commentComposer.querySelector<HTMLElement>('.comment-composer-label')!.textContent = draft.edit ? 'Edit change request' : 'Add a change request for the selection';
      activeSelectionText = draft.anchorText;
      activeSelectionOccurrence = draft.anchorOccurrence;
      activeSourceLine = draft.sourceLine;
      activeSourceLineEnd = draft.sourceLineEnd;
      commentBody.value = draft.text;
      commentComposer.style.display = 'block';
    } else if (draft.kind === 'block') {
      activeBlockEdit = draft.edit;
      blockEditorSurface.innerHTML = safeHtml(draft.html);
      blockEditorRaw.value = draft.raw || '';
      setBlockEditorRawMode(Boolean(draft.rawMode), { force: true });
      blockEditorTitle.textContent = draft.edit.mode === 'insert' ? 'Add block below' : 'Edit Markdown block';
      blockEditorSubmit.textContent = draft.edit.mode === 'insert' ? 'Add Below' : 'Save';
      blockEditor.style.display = 'block';
    } else if (draft.kind === 'mermaid') {
      activeMermaidEdit = draft.edit;
      mermaidEditorSource.value = draft.text;
      mermaidEditor.style.display = 'block';
    } else if (draft.kind === 'table') {
      activeTableEdit = draft.edit;
      renderTableEditorGrid(draft.table);
      tableEditor.style.display = 'block';
    } else { delete drafts[key]; return; }
    const form = formFor(key);
    if (form) {
      form.style.left = '16px';
      form.style.top = '48px';
      form.style.maxWidth = 'calc(100vw - 32px)';
    }
    status(form, draft.error || 'Draft restored. Review it before saving.');
    if (form) clampFloatingElement(form);
  }

  function copyPayload(draft: DraftData) {
    if (draft.kind === 'block') return draft.rawMode
      ? { text: draft.raw }
      : { html: draft.html, sourceMarkdown: draft.edit?.originalRawMarkdown || '' };
    if (draft.kind === 'table') return { table: draft.table };
    return { text: draft.text || '' };
  }

  function showRecovery() {
    recovery.replaceChildren();
    const keys = Object.keys(drafts).filter(key => drafts[key]?.recovery);
    recovery.hidden = keys.length === 0;
    for (const key of keys) {
      const draft = drafts[key];
      const item = document.createElement('div');
      const label = document.createElement('p');
      label.textContent = 'Unsaved ' + draft.kind + ' draft. ' + draft.recovery;
      const content = document.createElement('textarea');
      content.readOnly = true;
      content.setAttribute('aria-label', 'Recovered ' + draft.kind + ' draft');
      const payload = copyPayload(draft);
      if (payload.html) {
        const text = document.createElement('div'); text.innerHTML = safeHtml(payload.html);
        content.value = text.textContent;
      } else content.value = payload.text || JSON.stringify(payload.table, null, 2);
      const copy = document.createElement('button');
      copy.type = 'button'; copy.textContent = 'Copy draft';
      copy.addEventListener('click', () => vscode.postMessage({ type: 'copyDraft', ...copyPayload(draft) }));
      const discard = document.createElement('button');
      discard.type = 'button'; discard.className = 'secondary'; discard.textContent = 'Discard draft';
      discard.addEventListener('click', () => { clear(key, false); showRecovery(); });
      item.append(label, content, copy, discard);
      recovery.appendChild(item);
    }
  }

  Object.keys(drafts).forEach(key => restoreDraft(key, drafts[key]));
  restoring = false;
  persist();
  showRecovery();
  document.addEventListener('input', collect);
  document.addEventListener('change', collect);
  document.addEventListener('click', collect);
  window.addEventListener('pagehide', collect);
  window.addEventListener('message', event => {
    const message = readHostMessage(event.data);
    if (!message) return;
    if (message.type === 'reviewMutationResult') acceptResult(message);
    if (message.type === 'reviewRefreshFailed') {
      let notice = document.getElementById('review-refresh-error');
      if (!notice) {
        notice = document.createElement('section');
        notice.id = 'review-refresh-error'; notice.className = 'draft-recovery';
        notice.setAttribute('role', 'alert');
        markdownBody.before(notice);
      }
      notice.replaceChildren();
      const text = document.createElement('p');
      text.textContent = 'Preview could not refresh. Your drafts are kept. ' + String(message.error || '');
      const retry = document.createElement('button');
      retry.type = 'button'; retry.textContent = 'Retry refresh';
      retry.addEventListener('click', () => postReviewMessage({type:'refreshPreview'}));
      notice.append(text, retry);
      collect();
    }
  });
  for (const [button, key] of [[commentCancel, 'comment'], [blockEditorCancel, 'block'], [mermaidEditorCancel, 'mermaid'], [tableEditorCancel, 'table']] as const) {
    button.addEventListener('click', () => { clear(key, false); showRecovery(); });
  }
  return { submit, collect, refresh() {
    Object.keys(drafts).forEach(key => {
      const draft = drafts[key];
      const form = formFor(key);
      // The caller collected drafts before accepting the new sidecar state.
      // A live form already owns its DOM, selection and pending-save controls;
      // validate its request identity without replaying reload restoration.
      if (visible(form) && !draft.recovery) {
        const outcome = restoreState.mutationResults?.[draft.requestId];
        if (outcome?.ok) { clear(key, true); return; }
        if (outcome) {
          delete draft.requestId;
          draft.error = outcome.error || 'Not saved. Your draft is kept. Retry when ready.';
          freeze(form, false);
          status(form, draft.error);
        }
        if (draft.kind === 'comment' && draft.edit) {
          const current = findThread(draft.edit.threadId);
          if (!current || current.taskRevision !== draft.edit.revision || current.comment !== draft.edit.originalComment) {
            draft.recovery = 'The change request changed. Copy the draft, confirm the current request, and edit it again.';
          }
        } else if (draft.fingerprint !== state.sourceFingerprint) {
          draft.recovery = 'The document changed. Copy your draft, reopen the current target, and review it before saving.';
        }
      } else {
        restoreDraft(key, draft);
      }
      if (draft.recovery && form) form.style.display = 'none';
    });
    persist();
    showRecovery();
  }, canOpen(key: string) {
    if (!drafts[key]?.requestId && !drafts[key]?.recovery) return true;
    if (drafts[key]?.recovery) {
      recovery.scrollIntoView({block:'center'});
      recovery.querySelector<HTMLElement>('textarea')?.focus();
    } else status(formFor(key), 'Saving… Wait for confirmation before opening another target.');
    return false;
  } };
})();

restoreReadingPosition();
renderMermaidDiagrams();

function escapeHtml(value: unknown) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function getMermaidSource(figure: HTMLElement) {
  const sourceElement = figure.querySelector<HTMLElement>('.mermaid-source code');
  return String(sourceElement?.textContent || '').trim();
}

function getImageReviewAnchor(image: HTMLElement) {
  return String(
    image?.getAttribute('data-image-anchor')
    || image?.getAttribute('data-image-alt')
    || image?.getAttribute('data-image-src')
    || ''
  ).trim();
}

function getSearchableElementText(element: Element | null) {
  if (element?.matches?.('[data-markdown-image]')) {
    return [
      element.getAttribute('data-image-anchor') || '',
      element.getAttribute('data-image-alt') || '',
      element.getAttribute('data-image-src') || ''
    ].join(' ');
  }

  return element?.textContent || '';
}

function getSourceLine(element: Element | null) {
  const sourceElement = element?.closest?.('[data-source-line]');
  const sourceLine = Number(sourceElement?.getAttribute('data-source-line'));
  return Number.isFinite(sourceLine) && sourceLine > 0 ? Math.floor(sourceLine) : undefined;
}

function getSourceLineEnd(element: Element | null) {
  const sourceElement = element?.closest?.('[data-source-line-end]');
  const sourceLineEnd = Number(sourceElement?.getAttribute('data-source-line-end'));
  return Number.isFinite(sourceLineEnd) && sourceLineEnd > 0 ? Math.floor(sourceLineEnd) : undefined;
}

function decorateEditableMarkdownBlocks() {
  markdownBody.querySelectorAll<HTMLElement>('[data-mermaid-edit]').forEach((button) => {
    button.hidden = Boolean(button.closest<HTMLElement>('li, blockquote'));
  });
  const blocks = getEditableBlocks();

  for (const block of blocks) {
    if (block.querySelector<HTMLElement>(':scope > .block-edit-actions')) {
      continue;
    }

    block.classList.add('editable-markdown-block');
    const actions = document.createElement('span');
    actions.className = 'block-edit-actions';
    actions.innerHTML = [
      '<button type="button" class="secondary compact" title="Edit this block manually and keep attached comments updated" data-edit-markdown-block>Edit</button>',
      '<button type="button" class="secondary compact" title="Add a new Markdown block on a new line below this block" data-add-markdown-block>Add Below</button>',
      '<button type="button" class="secondary compact danger" title="Delete this block and keep affected comments visible" data-delete-markdown-block>Delete</button>'
    ].join('');
    block.appendChild(actions);
  }
}

function getEditableBlocks() {
  const selectors = 'p, h1, h2, h3, h4, h5, h6, li, blockquote';
  return Array.from(markdownBody.querySelectorAll(selectors))
    .filter((element) => element.hasAttribute('data-source-line'))
    .filter((element) => !element.parentElement?.closest<HTMLElement>('li, blockquote'))
    .filter((element) => !element.closest<HTMLElement>('pre, code, table, .mermaid-source, [data-mermaid-diagram]'));
}

function decorateEditableMarkdownTables() {
  const tables = Array.from(markdownBody.querySelectorAll<HTMLElement>('table[data-source-line]'))
    .filter((table) => !table.parentElement?.closest<HTMLElement>('li, blockquote'));

  for (const table of tables) {
    if (table.closest<HTMLElement>('[data-table-edit-wrapper]')) {
      decorateReviewableTableCells(table);
      continue;
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'editable-markdown-table';
    wrapper.dataset.tableEditWrapper = 'true';
    table.parentNode?.insertBefore(wrapper, table);
    wrapper.appendChild(table);

    const actions = document.createElement('span');
    actions.className = 'block-edit-actions';
    actions.innerHTML = [
      '<button type="button" class="secondary compact" title="Comment on this table" data-comment-markdown-table>Comment Table</button>',
      '<button type="button" class="secondary compact" title="Edit this Markdown table as a grid" data-source-edit-control data-edit-markdown-table hidden>Edit Table</button>'
    ].join('');
    wrapper.appendChild(actions);
    decorateReviewableTableCells(table);
  }
}

function decorateReviewableTableCells(table: HTMLElement) {
  const cells = Array.from(table.querySelectorAll<HTMLElement>('th, td'));

  for (const cell of cells) {
    cell.classList.add('reviewable-table-cell');

    if (cell.querySelector<HTMLElement>(':scope > .table-cell-comment')) {
      continue;
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary compact table-cell-comment';
    button.title = 'Comment on this table cell';
    button.setAttribute('data-comment-markdown-table-cell', '');
    button.textContent = 'Comment';
    cell.appendChild(button);
  }
}

function openComposerForTable(table: HTMLElement) {
  const text = getCleanTableText(table);

  if (!text) {
    return;
  }

  openComposerForElementText(
    table,
    text,
    getSourceLine(table),
    getSourceLineEnd(table)
  );
}

function openComposerForTableCell(cell: HTMLElement) {
  const text = getCleanTableText(cell);

  if (!text) {
    return;
  }

  openComposerForElementText(
    cell,
    text,
    getSourceLine(cell) || getSourceLine(cell.closest<HTMLElement>('tr')) || getSourceLine(cell.closest<HTMLElement>('table')),
    getSourceLineEnd(cell) || getSourceLineEnd(cell.closest<HTMLElement>('tr')) || getSourceLineEnd(cell.closest<HTMLElement>('table'))
  );
}

function openComposerForElementText(element: HTMLElement, text: string, lineStart?: number, lineEnd?: number) {
  if (protectCommentDraft()) return;
  clearDraftSelectionHighlight();
  activeSelectionText = text;
  activeSelectionOccurrence = 0;
  activeSourceLine = lineStart;
  activeSourceLineEnd = lineEnd || lineStart;
  activeSelectionRange = null;

  const rect = element.getBoundingClientRect();
  activeSelectionRect = {
    left: rect.left,
    right: rect.right,
    top: rect.top,
    bottom: rect.bottom
  };
  openComposer();
}

function getCleanTableText(element: HTMLElement) {
  const clone = element.cloneNode(true) as HTMLElement;
  clone.querySelectorAll<HTMLElement>('button, .table-cell-comment, .block-edit-actions, .review-badge').forEach((child) => child.remove());
  return normalizeInline(clone.textContent || '');
}

function openBlockEditor(block: HTMLElement, intent: string) {
  const lineRange = getEditableLineRange(block);

  if (!lineRange) {
    return;
  }

  if (!prepareBlockEditor()) {
    return;
  }

  const rawMarkdown = getSourceMarkdown(lineRange);
  const clone = block.cloneNode(true) as HTMLElement;
  clone.querySelectorAll<HTMLElement>('.review-badge, .block-edit-actions').forEach((element) => element.remove());
  clone.querySelectorAll<HTMLElement>('.review-anchor').forEach((element) => {
    element.replaceWith(document.createTextNode(element.textContent || ''));
  });

  blockEditorSurface.innerHTML = wrapEditableBlockHtml(block, clone.innerHTML);
  blockEditorRaw.value = rawMarkdown;
  setBlockEditorRawMode(Boolean(block.querySelector<HTMLElement>('table, [data-mermaid-diagram]')), { force: true });
  setBlockEditorStatus('');
  activeBlockEdit = {
    ...lineRange,
    mode: 'edit',
    intent,
    originalHtml: blockEditorSurface.innerHTML,
    originalRawMarkdown: rawMarkdown
  };
  blockEditorDelete.textContent = 'Delete';
  blockEditorDelete.hidden = false;
  blockEditorSubmit.textContent = 'Save';
  blockEditorTitle.textContent = 'Edit Markdown block';
  blockEditorLines.textContent = 'Lines ' + lineRange.lineStart + '-' + lineRange.lineEnd;
  showBlockEditorNear(block);
  blockEditorSurface.focus();
}

function openInsertBlockEditor(block: HTMLElement) {
  const lineRange = getEditableLineRange(block);

  if (!lineRange) {
    return;
  }

  if (!prepareBlockEditor()) {
    return;
  }

  const emptyHtml = '<p><br></p>';
  blockEditorSurface.innerHTML = emptyHtml;
  blockEditorRaw.value = '';
  setBlockEditorRawMode(Boolean(block.querySelector<HTMLElement>('table, [data-mermaid-diagram]')), { force: true });
  setBlockEditorStatus('');
  activeBlockEdit = {
    mode: 'insert',
    afterLine: lineRange.lineEnd,
    originalHtml: emptyHtml,
    originalRawMarkdown: ''
  };
  blockEditorDelete.textContent = 'Clear';
  blockEditorDelete.hidden = false;
  blockEditorSubmit.textContent = 'Add Below';
  blockEditorTitle.textContent = 'Add block below';
  blockEditorLines.textContent = 'New block after line ' + lineRange.lineEnd;
  showBlockEditorNear(block);
  blockEditorSurface.focus();
}

function prepareBlockEditor() {
  if (!canEditMarkdown || !viewState.editDocument) return false;
  if (draftSession && !draftSession.canOpen('block')) return false;
  if (commentComposer.style.display === 'block' && commentBody.value.trim()) {
    commentBody.focus();
    return false;
  }

  if (mermaidEditor.style.display === 'block'
    && activeMermaidEdit
    && mermaidEditorSource.value !== activeMermaidEdit.originalSource) {
    mermaidEditorSource.focus();
    return false;
  }

  if (tableEditor.style.display === 'block'
    && activeTableEdit
    && tableEditorSignature() !== activeTableEdit.originalSignature) {
    focusFirstTableInput();
    return false;
  }

  if (blockEditor.style.display === 'block' && isBlockEditorDirty()) {
    focusActiveBlockEditorInput();
    return false;
  }

  if (!hideCommentOverlayIfClean()) {
    return false;
  }
  hideSelectionPopover();
  hideComposerIfEmpty();
  hideMermaidEditorIfClean();
  hideTableEditorIfClean();
  return true;
}

function showBlockEditorNear(block: HTMLElement) {
  const rect = block.getBoundingClientRect();
  positionFloatingElement(blockEditor, {
    left: rect.left,
    right: rect.right,
    top: rect.top,
    bottom: rect.bottom
  }, 680);
  blockEditor.style.display = 'block';
}

function focusActiveBlockEditorInput() {
  if (isBlockEditorRawMode()) {
    blockEditorRaw.focus();
    return;
  }

  blockEditorSurface.focus();
}

function getSourceMarkdown(lineRange: LineRange) {
  return sourceLines
    .slice(Math.max(0, lineRange.lineStart - 1), Math.max(0, lineRange.lineEnd))
    .join(sourceLineEnding);
}

function toggleBlockEditorRawMode() {
  if (!activeBlockEdit) {
    return;
  }

  if (isBlockEditorRawMode()) {
    if (isBlockEditorDirty()) {
      setBlockEditorStatus('Save raw Markdown before returning to rich edit.');
      focusActiveBlockEditorInput();
      return;
    }

    setBlockEditorRawMode(false);
    setBlockEditorStatus('');
    focusActiveBlockEditorInput();
    return;
  }

  if (isBlockEditorDirty()) {
    requestRawMarkdownForBlockEditor();
    return;
  }

  setBlockEditorRawMode(true);
  setBlockEditorStatus('');
  focusActiveBlockEditorInput();
}

function requestRawMarkdownForBlockEditor() {
  if (!activeBlockEdit || pendingBlockRawConversionId) {
    return;
  }

  const lineStart = activeBlockEdit.mode === 'insert'
    ? activeBlockEdit.afterLine + 1
    : activeBlockEdit.lineStart;
  pendingBlockRawConversionId = 'block-raw-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  pendingBlockRawConversionHtml = serializeBlockEditorHtml();
  blockEditorRawToggle.disabled = true;
  setBlockEditorStatus('Converting to Markdown...');
  postReviewMessage({
    type: 'convertMarkdownBlockHtml',
    requestId: pendingBlockRawConversionId,
    lineStart,
    html: pendingBlockRawConversionHtml
  });
}

function setBlockEditorRawMode(enabled: boolean, options: { force?: boolean } = {}) {
  if (!activeBlockEdit && !options.force) {
    return;
  }

  blockEditorRaw.classList.toggle('is-visible', enabled);
  blockEditorSurface.classList.toggle('is-hidden', enabled);
  blockEditorRawToggle.setAttribute('aria-pressed', enabled ? 'true' : 'false');
  blockEditorRawToggle.classList.toggle('compact-active', enabled);
}

function setBlockEditorStatus(message: string) {
  blockEditorStatus.textContent = message || '';
}

function isBlockEditorRawMode() {
  return blockEditorRaw.classList.contains('is-visible');
}

function isBlockEditorDirty() {
  if (!activeBlockEdit) {
    return false;
  }

  if (isBlockEditorRawMode()) {
    return blockEditorRaw.value !== activeBlockEdit.originalRawMarkdown;
  }

  return blockEditorSurface.innerHTML !== activeBlockEdit.originalHtml;
}

function openTableEditor(tableElement: HTMLElement) {
  if (!canEditMarkdown || !viewState.editDocument) return;
  if (draftSession && !draftSession.canOpen('table')) return;
  const lineRange = getEditableLineRange(tableElement);

  if (!lineRange) {
    return;
  }

  if (commentComposer.style.display === 'block' && commentBody.value.trim()) {
    commentBody.focus();
    return;
  }

  if (blockEditor.style.display === 'block'
    && activeBlockEdit
    && isBlockEditorDirty()) {
    focusActiveBlockEditorInput();
    return;
  }

  if (mermaidEditor.style.display === 'block'
    && activeMermaidEdit
    && mermaidEditorSource.value !== activeMermaidEdit.originalSource) {
    mermaidEditorSource.focus();
    return;
  }

  if (tableEditor.style.display === 'block'
    && activeTableEdit
    && tableEditorSignature() !== activeTableEdit.originalSignature) {
    focusFirstTableInput();
    return;
  }

  const table = findTableEditData(lineRange) || readTableDataFromDom(tableElement);
  if (!hideCommentOverlayIfClean()) {
    return;
  }
  hideSelectionPopover();
  hideComposerIfEmpty();
  hideBlockEditorIfClean();
  hideMermaidEditorIfClean();
  activeTableEdit = {
    ...lineRange,
    rowSources: table.rows.map((_, index) => index),
    columnSources: table.headers.map((_, index) => index),
    originalSignature: ''
  };
  renderTableEditorGrid(table);
  activeTableEdit.originalSignature = tableEditorSignature();
  tableEditorLines.textContent = 'Lines ' + lineRange.lineStart + '-' + lineRange.lineEnd;
  const rect = tableElement.getBoundingClientRect();
  positionFloatingElement(tableEditor, {
    left: rect.left,
    right: rect.right,
    top: rect.top,
    bottom: rect.bottom
  }, 920);
  tableEditor.style.display = 'block';
  focusFirstTableInput();
}

function findTableEditData(lineRange: LineRange) {
  return markdownTables.find((table) => {
    return Number(table.lineStart) === lineRange.lineStart
      && Number(table.lineEnd) === lineRange.lineEnd;
  });
}

function readTableDataFromDom(tableElement: HTMLElement) {
  const headers = Array.from(tableElement.querySelectorAll<HTMLElement>('thead th')).map((cell) => cell.textContent || '');
  const bodyRows = Array.from(tableElement.querySelectorAll<HTMLElement>('tbody tr')).map((row) => {
    return Array.from(row.querySelectorAll<HTMLElement>('td, th')).map((cell) => cell.textContent || '');
  });
  const fallbackRows = bodyRows.length > 0
    ? bodyRows
    : Array.from(tableElement.querySelectorAll<HTMLElement>('tr')).slice(1).map((row) => {
      return Array.from(row.querySelectorAll<HTMLElement>('td, th')).map((cell) => cell.textContent || '');
    });
  const columnCount = Math.max(1, headers.length, ...fallbackRows.map((row) => row.length));
  return normalizeTableData({
    headers: padTableCells(headers.length > 0 ? headers : Array.from({ length: columnCount }, (_, index) => 'Column ' + (index + 1)), columnCount),
    alignments: Array.from({ length: columnCount }, () => 'none'),
    rows: fallbackRows.map((row) => padTableCells(row, columnCount))
  });
}

function normalizeTableData(table: MarkdownTableData) {
  const rows = Array.isArray(table?.rows) ? table.rows.filter(Array.isArray) : [];
  const headers = Array.isArray(table?.headers) ? table.headers.map(String) : [];
  const alignments = Array.isArray(table?.alignments) ? table.alignments.map(normalizeAlignment) : [];
  const columnCount = Math.max(1, headers.length, alignments.length, ...rows.map((row) => row.length));
  return {
    headers: padTableCells(headers, columnCount),
    alignments: padTableAlignments(alignments, columnCount),
    rows: rows.map((row) => padTableCells(row.map(String), columnCount))
  };
}

function padTableCells(cells: string[], columnCount: number) {
  return Array.from({ length: columnCount }, (_, index) => cells[index] || '');
}

function padTableAlignments(alignments: TableAlignment[], columnCount: number) {
  return Array.from({ length: columnCount }, (_, index) => normalizeAlignment(alignments[index]));
}

function normalizeAlignment(value: string | undefined): TableAlignment {
  return value === 'left' || value === 'center' || value === 'right' ? value : 'none';
}

function renderTableEditorGrid(table: MarkdownTableData) {
  const normalizedTable = normalizeTableData(table);
  tableEditorGrid.innerHTML = [
    '<table>',
    '<thead>',
    '<tr>',
    '<th></th>',
    ...normalizedTable.headers.map((header, columnIndex) => [
      '<th>',
      '<input data-table-header data-column="' + columnIndex + '" value="' + escapeHtml(header) + '" aria-label="Column ' + (columnIndex + 1) + ' header">',
      '<div class="table-cell-tools">',
      '<select data-table-align data-column="' + columnIndex + '" aria-label="Column ' + (columnIndex + 1) + ' alignment">',
      renderAlignmentOptions(normalizedTable.alignments[columnIndex]),
      '</select>',
      '<button type="button" class="secondary compact" title="Remove column" data-remove-table-column data-column="' + columnIndex + '">-</button>',
      '</div>',
      '</th>'
    ].join('')),
    '</tr>',
    '</thead>',
    '<tbody>',
    ...normalizedTable.rows.map((row, rowIndex) => [
      '<tr>',
      '<td><button type="button" class="secondary compact" title="Remove row" data-remove-table-row data-row="' + rowIndex + '">-</button></td>',
      ...row.map((cell, columnIndex) => [
        '<td>',
        '<input data-table-cell data-row="' + rowIndex + '" data-column="' + columnIndex + '" value="' + escapeHtml(cell) + '" aria-label="Row ' + (rowIndex + 1) + ', column ' + (columnIndex + 1) + '">',
        '</td>'
      ].join('')),
      '</tr>'
    ].join('')),
    '</tbody>',
    '</table>'
  ].join('');
}

function formatMetaValue(value: string): string { return value.replace(/[-_]+/g, ' ').replace(/\b\w/g, character => character.toUpperCase()); }

function renderAlignmentOptions(selected: TableAlignment) {
  return ['none', 'left', 'center', 'right'].map((alignment) => {
    return '<option value="' + alignment + '"' + (alignment === selected ? ' selected' : '') + '>' + formatMetaValue(alignment) + '</option>';
  }).join('');
}

function readTableEditorData(): MarkdownTableData {
  const headers = Array.from(tableEditorGrid.querySelectorAll<HTMLInputElement>('[data-table-header]'))
    .sort(sortByColumn)
    .map((input) => input.value);
  const alignments = Array.from(tableEditorGrid.querySelectorAll<HTMLSelectElement>('[data-table-align]'))
    .sort(sortByColumn)
    .map((select) => normalizeAlignment(select.value));
  const rowElements = Array.from(tableEditorGrid.querySelectorAll<HTMLElement>('tbody tr'));
  const rows = rowElements.map((row) => {
    return Array.from(row.querySelectorAll<HTMLInputElement>('[data-table-cell]'))
      .sort(sortByColumn)
      .map((input) => input.value);
  });
  return normalizeTableData({ headers, alignments, rows });
}

function sortByColumn(left: HTMLElement, right: HTMLElement) {
  return Number(left.getAttribute('data-column')) - Number(right.getAttribute('data-column'));
}

function tableEditorSignature() {
  return JSON.stringify(readTableEditorData());
}

function focusTableCell(rowIndex: number, columnIndex: number) {
  const selector = rowIndex === 0
    ? '[data-table-header][data-column="' + columnIndex + '"]'
    : '[data-table-cell][data-row="' + (rowIndex - 1) + '"][data-column="' + columnIndex + '"]';
  const input = tableEditorGrid.querySelector<HTMLElement>(selector);
  input?.focus();
}

function focusFirstTableInput() {
  tableEditorGrid.querySelector<HTMLElement>('input, select')?.focus();
}

function openMermaidEditor(figure: HTMLElement, source: string) {
  if (!canEditMarkdown || !viewState.editDocument) return;
  if (draftSession && !draftSession.canOpen('mermaid')) return;
  if (figure.parentElement?.closest<HTMLElement>('li, blockquote')) {
    return;
  }
  const lineRange = getEditableLineRange(figure);

  if (!lineRange) {
    return;
  }

  if (commentComposer.style.display === 'block' && commentBody.value.trim()) {
    commentBody.focus();
    return;
  }

  if (blockEditor.style.display === 'block'
    && activeBlockEdit
    && isBlockEditorDirty()) {
    focusActiveBlockEditorInput();
    return;
  }

  if (mermaidEditor.style.display === 'block'
    && activeMermaidEdit
    && mermaidEditorSource.value !== activeMermaidEdit.originalSource) {
    mermaidEditorSource.focus();
    return;
  }

  if (tableEditor.style.display === 'block'
    && activeTableEdit
    && tableEditorSignature() !== activeTableEdit.originalSignature) {
    focusFirstTableInput();
    return;
  }

  if (!hideCommentOverlayIfClean()) {
    return;
  }
  hideSelectionPopover();
  hideComposerIfEmpty();
  hideBlockEditorIfClean();
  hideTableEditorIfClean();
  activeMermaidEdit = {
    ...lineRange,
    originalSource: source
  };
  mermaidEditorSource.value = source;
  mermaidEditorLines.textContent = 'Lines ' + lineRange.lineStart + '-' + lineRange.lineEnd;
  const rect = figure.getBoundingClientRect();
  positionFloatingElement(mermaidEditor, {
    left: rect.left,
    right: rect.right,
    top: rect.top,
    bottom: rect.bottom
  }, 680);
  mermaidEditor.style.display = 'block';
  mermaidEditorSource.focus();
}

function wrapEditableBlockHtml(block: HTMLElement, innerHtml: string) {
  const tag = block.tagName.toLowerCase();

  if (tag === 'li') {
    return wrapEditableListItemHtml(block, innerHtml);
  }

  if (/^(p|h[1-6]|li|blockquote)$/.test(tag)) {
    return '<' + tag + '>' + innerHtml + '</' + tag + '>';
  }

  return '<p>' + innerHtml + '</p>';
}

function wrapEditableListItemHtml(block: HTMLElement, innerHtml: string) {
  return [
    '<div class="editable-list-item" data-editable-list-item>',
    '<span class="editable-list-marker" contenteditable="false" aria-hidden="true">',
    escapeHtml(getListMarkerLabel(block)),
    '</span>',
    '<div class="editable-list-body" data-editable-list-body>',
    innerHtml,
    '</div>',
    '</div>'
  ].join('');
}

function getListMarkerLabel(block: HTMLElement) {
  const list = block.parentElement;
  const listTag = list?.tagName?.toLowerCase();

  if (list && listTag === 'ol') {
    const start = Number(list.getAttribute('start')) || 1;
    const itemIndex = Array.from(list.children)
      .filter((child) => child.tagName?.toLowerCase() === 'li')
      .indexOf(block);
    return String(start + Math.max(0, itemIndex)) + '.';
  }

  return '-';
}

function serializeBlockEditorHtml() {
  const listBody = blockEditorSurface.querySelector<HTMLElement>('[data-editable-list-body]');

  if (listBody instanceof HTMLElement) {
    return '<li>' + listBody.innerHTML + '</li>';
  }

  return blockEditorSurface.innerHTML;
}

function getEditableLineRange(block: HTMLElement) {
  const lineStart = getSourceLine(block);

  if (!lineStart) {
    return undefined;
  }

  const sourceLineEnd = getSourceLineEnd(block);

  if (sourceLineEnd) {
    return { lineStart, lineEnd: Math.max(lineStart, sourceLineEnd) };
  }

  const nextLine = getEditableBlocks()
    .map(getSourceLine)
    .filter((line): line is number => typeof line === 'number' && Number.isFinite(line) && line > lineStart)
    .sort((left, right) => left - right)[0];
  const lineEnd = Math.max(lineStart, nextLine ? nextLine - 1 : lineStart);
  return { lineStart, lineEnd };
}

function applyInlineFormat(format: string) {
  if (format === 'bold') {
    document.execCommand('bold');
  } else if (format === 'italic') {
    document.execCommand('italic');
  } else if (format === 'code') {
    toggleInlineCode();
  }
}

function toggleInlineCode() {
  const selection = window.getSelection();

  if (!selection || selection.rangeCount === 0 || !isSelectionInsideBlockEditor(selection)) {
    blockEditorSurface.focus();
    insertInlineCodePlaceholder();
    return;
  }

  const existingCode = closestCodeElement(selection.anchorNode);

  if (existingCode && blockEditorSurface.contains(existingCode)) {
    unwrapElement(existingCode);
    return;
  }

  const range = selection.getRangeAt(0);

  if (range.collapsed) {
    insertInlineCodePlaceholder(range);
    return;
  }

  const codeElement = document.createElement('code');
  codeElement.appendChild(range.extractContents());
  range.insertNode(codeElement);
  selectNodeContents(codeElement);
}

function insertInlineCodePlaceholder(range?: Range) {
  const targetRange = range || document.createRange();

  if (!range) {
    targetRange.selectNodeContents(blockEditorSurface);
    targetRange.collapse(false);
  }

  const codeElement = document.createElement('code');
  codeElement.textContent = 'code';
  targetRange.insertNode(codeElement);
  selectNodeContents(codeElement);
}

function isSelectionInsideBlockEditor(selection: Selection) {
  return Boolean(selection.anchorNode && blockEditorSurface.contains(selection.anchorNode));
}

function closestCodeElement(node: Node | null) {
  const element = node instanceof HTMLElement
    ? node
    : node?.parentElement;
  return element?.closest?.('code');
}

function unwrapElement(element: Element) {
  const parent = element.parentNode;

  if (!parent) {
    return;
  }

  const fragment = document.createDocumentFragment();

  while (element.firstChild) {
    fragment.appendChild(element.firstChild);
  }

  parent.replaceChild(fragment, element);
}

function selectNodeContents(node: Node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function applyBlockFormat(format: string) {
  if (format === 'h2' || format === 'h3') {
    document.execCommand('formatBlock', false, format);
  } else {
    document.execCommand('formatBlock', false, 'p');
  }
}

function hideBlockEditor() {
  if (blockEditor.getAttribute('aria-busy') === 'true') return;
  blockEditor.style.display = 'none';
  blockEditorSurface.innerHTML = '';
  blockEditorRaw.value = '';
  pendingBlockRawConversionId = '';
  blockEditorRawToggle.disabled = false;
  setBlockEditorStatus('');
  setBlockEditorRawMode(false, { force: true });
  activeBlockEdit = undefined;
}

function hideBlockEditorIfClean() {
  if (blockEditor.style.display !== 'block') {
    return;
  }

  if (isBlockEditorDirty()) {
    return;
  }

  hideBlockEditor();
}

function hideMermaidEditor() {
  if (mermaidEditor.getAttribute('aria-busy') === 'true') return;
  mermaidEditor.style.display = 'none';
  mermaidEditorSource.value = '';
  activeMermaidEdit = undefined;
}

function hideMermaidEditorIfClean() {
  if (mermaidEditor.style.display !== 'block') {
    return;
  }

  if (activeMermaidEdit && mermaidEditorSource.value !== activeMermaidEdit.originalSource) {
    return;
  }

  hideMermaidEditor();
}

function hideTableEditor() {
  if (tableEditor.getAttribute('aria-busy') === 'true') return;
  tableEditor.style.display = 'none';
  tableEditorGrid.innerHTML = '';
  activeTableEdit = undefined;
}

function hideTableEditorIfClean() {
  if (tableEditor.style.display !== 'block') {
    return;
  }

  if (activeTableEdit && tableEditorSignature() !== activeTableEdit.originalSignature) {
    return;
  }

  hideTableEditor();
}

function decorateReviewAnchors(threads: ReviewThread[]) {
  for (const thread of threads) {
    const anchorText = normalizeInline(thread.anchor?.text || '');

    if (!anchorText
      || anchorText.length < 2
      || looksLikeMarkdownImageAnchor(anchorText)) {
      continue;
    }

    highlightTextNode(thread, anchorText)
      || highlightContainingBlock(thread, anchorText)
;
  }
}

function shouldAutoLocateThread(thread: ReviewThread) {
  return !['missing', 'ambiguous'].includes(String(thread.anchor?.confidence || '').toLowerCase());
}

function highlightTextNode(thread: ReviewThread, anchorText: string) {
  const walker = document.createTreeWalker(markdownBody, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;

      if (!parent || shouldSkipHighlightParent(parent)) {
        return NodeFilter.FILTER_REJECT;
      }

      return node.nodeValue && normalizeInline(node.nodeValue).includes(anchorText)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_SKIP;
    }
  });
  const candidates: TextMatch[] = [];
  let occurrenceIndex = 0;
  let node = walker.nextNode() as Text | null;

  while (node?.nodeValue) {
    const normalizedNode = normalizeInline(node.nodeValue);
    let searchStart = 0;
    let index = normalizedNode.indexOf(anchorText, searchStart);

    while (index >= 0) {
      const rawMatch = findNormalizedTextSpan(node.nodeValue, anchorText, index);

      if (!rawMatch) {
        searchStart = index + anchorText.length;
        index = normalizedNode.indexOf(anchorText, searchStart);
        continue;
      }

      const rawIndex = rawMatch.start;
      const matchLength = rawMatch.length;

      if (matchLength > 0) {
        candidates.push({
          node,
          rawIndex,
          matchLength,
          occurrenceIndex,
          element: node.parentElement!
        });
      }

      occurrenceIndex += 1;
      searchStart = index + anchorText.length;
      index = normalizedNode.indexOf(anchorText, searchStart);
    }

    node = walker.nextNode() as Text | null;
  }

  const selected = selectTextMatchCandidate(thread, candidates, anchorText);

  if (!selected) {
    return false;
  }

  const matchNode = selected.node.splitText(selected.rawIndex);
  const afterNode = matchNode.splitText(selected.matchLength);
  const marker = document.createElement('span');
  marker.className = 'review-anchor ' + sourceClass(thread);
  marker.dataset.threadId = thread.id;
  marker.title = sourceLabel(thread) + ' comment';
  marker.textContent = matchNode.nodeValue;

  const badge = createReviewBadge(thread, '', sourceBadgeLabel(thread));
  marker.appendChild(badge);
  matchNode.parentNode?.insertBefore(marker, matchNode);
  matchNode.remove();
  afterNode.parentElement?.normalize();
  setAnchorState(thread, 'exact', marker);
  return true;
}

function highlightContainingBlock(thread: ReviewThread, anchorText: string) {
  const candidates = Array.from(markdownBody.querySelectorAll<HTMLElement>('p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote, pre[data-review-code-fence], [data-markdown-image]'));
  const matches = candidates.filter((element) => {
    return !shouldSkipHighlightParent(element)
      && normalizeInline(getSearchableElementText(element)).includes(anchorText);
  });
  const target = selectElementMatchCandidate(thread, matches, anchorText);

  if (!target) {
    return false;
  }

  attachThreadToAnchorElement(target, thread, 'review-block-badge', 'exact');
  return true;
}

function candidateContext(element: HTMLElement, before = '', after = '', quote = '') {
  const line = getSourceLine(element);
  const end = getSourceLineEnd(element) || line;
  const blockSource = sourceLines.slice(Math.max(0, (line || 1) - 1), end).join('\n');
  const normalizedBlock = normalizeInline(blockSource);
  const normalizedQuote = normalizeInline(quote);
  const at = normalizedQuote ? normalizedBlock.indexOf(normalizedQuote) : -1;
  // Use raw source context for images, diagrams and Markdown formatting whenever
  // that block contains one exact occurrence. DOM labels must not alter identity.
  if (at >= 0 && normalizedBlock.indexOf(normalizedQuote, at + normalizedQuote.length) < 0) {
    const span = findNormalizedTextSpan(blockSource, normalizedQuote, at);
    if (span) { before = blockSource.slice(0, span.start); after = blockSource.slice(span.start + span.length); }
  }
  return {
    line,
    before: sourceLines.slice(0, Math.max(0, (line || 1) - 1)).join('\n') + '\n' + before,
    after: after + '\n' + sourceLines.slice(end || 0).join('\n')
  };
}

function selectTextMatchCandidate(thread: ReviewThread, candidates: TextMatch[], _anchorText: string) {
  return chooseTargetCandidate(thread.anchor, candidates.map(candidate => ({
    value: candidate,
    occurrence: candidate.occurrenceIndex,
    ...candidateContext(candidate.element, String(candidate.node.nodeValue || '').slice(0, candidate.rawIndex), String(candidate.node.nodeValue || '').slice(candidate.rawIndex + candidate.matchLength), thread.anchor.text)
  })));
}

function selectElementMatchCandidate(thread: ReviewThread, candidates: HTMLElement[], _anchorText: string) {
  return chooseTargetCandidate(thread.anchor, candidates.map((element, occurrence) => ({
    value: element, occurrence, ...candidateContext(element, '', '', thread.anchor.text)
  })));
}

function attachThreadToAnchorElement(element: HTMLElement, thread: ReviewThread, badgeClass: string, anchorState: string) {
  element.classList.add('review-anchor-block');
  element.title = sourceLabel(thread) + ' comment';

  const existingIds = getThreadIds(element);
  const nextIds = existingIds.includes(thread.id) ? existingIds : [...existingIds, thread.id];
  element.dataset.threadId = nextIds[0];
  element.dataset.threadIds = nextIds.join(',');

  let badge = element.querySelector<HTMLElement>(':scope > .review-badge');

  if (!badge) {
    badge = createReviewBadge(thread, badgeClass);
    element.appendChild(badge);
  }

  badge.dataset.threadId = nextIds[0];
  badge.dataset.threadIds = element.dataset.threadIds;
  syncSourceClasses(element, badge, nextIds);
  setAnchorState(thread, anchorState, element);
}

function decorateMermaidReviewBadges(threads: ReviewThread[]) {
  const figures = Array.from(markdownBody.querySelectorAll<HTMLElement>('[data-mermaid-diagram]'));
  for (const thread of threads) {
    const quote = normalizeInline(thread.anchor.text);
    const candidates = figures.filter(figure => quote && normalizeInline(getMermaidSource(figure)) === quote);
    const figure = selectElementMatchCandidate(thread, candidates, quote);
    if (!figure) continue;
    figure.classList.add('has-review');
    attachThreadToAnchorElement(figure, thread, 'mermaid-review-badge', 'exact');
  }
}

function decorateImageReviewBadges(threads: ReviewThread[]) {
  const images = Array.from(markdownBody.querySelectorAll<HTMLElement>('[data-markdown-image]'));
  for (const thread of threads) {
    const quote = normalizeInline(thread.anchor.text);
    const matches = images.filter(image => quote && quote === normalizeInline(getImageReviewAnchor(image)));
    const image = selectElementMatchCandidate(thread, matches, quote);
    if (!image) continue;
    image.classList.add('has-review');
    attachThreadToAnchorElement(image, thread, 'image-review-badge', 'exact');
  }
}

function createReviewBadge(thread: ReviewThread, extraClass = "", label = "") {
  const badge = document.createElement('button');
  badge.type = 'button';
  badge.className = ('review-badge ' + sourceClass(thread) + ' ' + extraClass).trim();
  badge.title = sourceLabel(thread) + ' comment';
  badge.setAttribute('aria-label', 'Open comment: ' + String(thread.comment || sourceLabel(thread) + ' comment'));
  badge.textContent = label || '1';
  badge.dataset.threadId = thread.id;
  return badge;
}

function setAnchorState(thread: ReviewThread, state: string, anchorElement?: HTMLElement) {
  const threadCard = document.querySelector<HTMLElement>('.thread[data-thread-id="' + cssEscape(thread.id) + '"]');

  if (!threadCard) {
    return;
  }

  const current = threadCard.dataset.anchorState || '';

  if (anchorStateRank(current) >= anchorStateRank(state)) {
    return;
  }

  const classNames = ['anchor-exact', 'anchor-recovered', 'anchor-approximate', 'anchor-missing'];
  threadCard.dataset.anchorState = state;
  threadCard.classList.remove(...classNames);
  threadCard.classList.add('anchor-' + state);

  if (anchorElement) {
    anchorElement.classList.remove(...classNames);
    anchorElement.classList.add('anchor-' + state);
  }
}

function markMissingAnchors(threads: ReviewThread[]) {
  for (const thread of threads) {
    const threadCard = document.querySelector<HTMLElement>('.thread[data-thread-id="' + cssEscape(thread.id) + '"]');

    if (!threadCard?.dataset.anchorState) {
      setAnchorState(thread, 'missing');
    }
  }
}

function anchorStateRank(state: string) {
  if (state === 'exact') {
    return 4;
  }

  if (state === 'recovered') {
    return 3;
  }

  if (state === 'approximate') {
    return 2;
  }

  if (state === 'missing') {
    return 1;
  }

  return 0;
}

function getAnchorElementState(element: HTMLElement) {
  if (element.classList.contains('anchor-exact')) {
    return 'exact';
  }

  if (element.classList.contains('anchor-recovered')) {
    return 'recovered';
  }

  if (element.classList.contains('anchor-approximate')) {
    return 'approximate';
  }

  return 'missing';
}

function syncSourceClasses(anchor: HTMLElement, badge: HTMLElement, threadIds: string[]) {
  const threads = threadIds.map(findThread).filter(isPresent);
  const source = aggregateSource(threads);
  const classNames = ['source-human', 'source-ai', 'source-mixed'];

  anchor.classList.remove(...classNames);
  badge.classList.remove(...classNames);
  anchor.classList.add(source.cssClass);
  badge.classList.add(source.cssClass);
  badge.textContent = threadIds.length === 1 ? source.label : String(threadIds.length);
  badge.title = threadIds.length === 1
    ? source.label + ' comment'
    : source.label + ' comments';
}

function aggregateSource(threads: ReviewThread[]) {
  const sourceKinds = Array.from(new Set(threads.map(sourceKind)));

  if (sourceKinds.length === 1) {
    return sourceDisplay(sourceKinds[0]);
  }

  return sourceDisplay('mixed');
}

function sourceKind(_thread: ReviewThread) { return 'human'; }

function sourceDisplay(_kind: string) { return { label: 'Comment', cssClass: 'source-human' }; }

function sourceClass(thread: ReviewThread) {
  return sourceDisplay(sourceKind(thread)).cssClass;
}

function sourceLabel(thread: ReviewThread) {
  return sourceDisplay(sourceKind(thread)).label;
}

function sourceBadgeLabel(thread: ReviewThread) {
  return sourceLabel(thread);
}

function getThreadIds(element: Element | null) {
  if (!element) return [];
  const encodedIds = element.getAttribute('data-thread-ids');

  if (encodedIds) {
    return encodedIds.split(',').map((value) => value.trim()).filter(isPresent);
  }

  const threadId = element.getAttribute('data-thread-id');
  return threadId ? [threadId] : [];
}

function findThread(threadId: string | null | undefined) {
  return openThreads.find((thread) => thread.id === threadId);
}

function openCommentOverlay(threadIds: string[], sourceElement: HTMLElement) {
  const threads = threadIds.map(findThread).filter(isPresent);

  if (threads.length === 0) {
    hideCommentOverlay();
    return;
  }

  overlayTrigger = sourceElement instanceof HTMLElement ? sourceElement : undefined;
  commentOverlay.innerHTML = '<button type="button" class="secondary compact" data-close-comments aria-label="Close comments">Close</button>' + threads.map(renderCommentOverlayItem).join('');
  commentOverlay.dataset.threadIds = threads.map((thread) => thread.id).join(',');
  const rect = sourceElement.getBoundingClientRect();
  positionFloatingElement(commentOverlay, {
    left: rect.left,
    right: rect.right,
    top: rect.top,
    bottom: rect.bottom
  }, 360);
  commentOverlay.style.display = 'block';
  document.body.classList.add('has-comment-overlay');
  commentOverlay.querySelector<HTMLElement>('[data-close-comments]')?.focus({ preventScroll: true });
}


function renderCommentOverlayItem(thread: ReviewThread) {
  return [
    '<section class="comment-overlay-item" data-thread-id="' + escapeHtml(thread.id) + '">',
    '<p class="comment-overlay-comment">' + escapeHtml(thread.comment || '') + '</p>',
    renderThreadActions(thread),
    '</section>'
  ].join('');
}

function renderThreadActions(thread: ReviewThread) {
  return [
    '<div class="thread-actions">',
    '<button type="button" class="secondary" aria-label="Show comment in document: ' + escapeHtml(thread.comment) + '" data-jump-thread>Show in document</button>',
    '<button type="button" class="secondary"' + (trusted ? '' : ' disabled') + ' data-write-action data-edit-comment data-thread-id="' + escapeHtml(thread.id) + '">Edit</button>',
    '<button type="button" class="secondary"' + (trusted ? '' : ' disabled') + ' data-write-action data-remove-comment data-thread-id="' + escapeHtml(thread.id) + '">Delete</button>',
    '</div>'
  ].join('');
}

function hideCommentOverlay() {
  const hadFocus = commentOverlay.contains(document.activeElement);
  commentOverlay.style.display = 'none';
  commentOverlay.innerHTML = '';
  document.body.classList.remove('has-comment-overlay');
  delete commentOverlay.dataset.threadIds;
  if (hadFocus && overlayTrigger?.isConnected) overlayTrigger.focus({ preventScroll: true });
  overlayTrigger = undefined;
}

function hideCommentOverlayIfClean() {
  if (commentOverlay.style.display !== 'block') {
    return true;
  }

  hideCommentOverlay();
  return true;
}

function restorePreviewState() {
  const focusThreadId = String(restoreState.focusThreadId || '');
  const overlayThreadIds = Array.isArray(restoreState.overlayThreadIds)
    ? restoreState.overlayThreadIds.map(String).filter(isPresent)
    : [];

  if (focusThreadId) {
    focusThread(focusThreadId, overlayThreadIds.length === 0);
  }

  if (overlayThreadIds.length > 0) {
    const sourceElement = findOverlaySourceElement(overlayThreadIds[0]);

    if (sourceElement) {
      openCommentOverlay(overlayThreadIds, sourceElement);
      focusThread(focusThreadId || overlayThreadIds[0], false);
    }
  }

}

function findOverlaySourceElement(threadId: string | null | undefined) {
  if (!threadId) return undefined;
  const badge = markdownBody.querySelector<HTMLElement>('.review-badge[data-thread-id="' + cssEscape(threadId) + '"]');

  if (badge) {
    return badge;
  }

  return markdownBody.querySelector<HTMLElement>('[data-thread-id="' + cssEscape(threadId) + '"]')
    || Array.from(markdownBody.querySelectorAll<HTMLElement>('.review-badge, [data-thread-ids]'))
      .find((element) => getThreadIds(element).includes(threadId));
}

function navigateReviewThread(direction: number) {
  const threadIds = getReviewNavigationIds();

  if (threadIds.length === 0) {
    return;
  }

  const currentThreadId = getCurrentReviewThreadId(threadIds);
  const currentIndex = threadIds.indexOf(currentThreadId);
  const baseIndex = currentIndex >= 0
    ? currentIndex
    : direction > 0
      ? -1
      : 0;
  const nextIndex = (baseIndex + direction + threadIds.length) % threadIds.length;
  revealReviewThread(threadIds[nextIndex]);
}

function getReviewNavigationIds() {
  const ids: string[] = [];
  const seen = new Set();
  const addId = (threadId: string) => {
    const id = String(threadId || '').trim();

    if (!id || seen.has(id) || !findThread(id)) {
      return;
    }

    seen.add(id);
    ids.push(id);
  };

  markdownBody
    .querySelectorAll<HTMLElement>('.review-badge, .review-anchor, .review-anchor-block, [data-mermaid-diagram].has-review')
    .forEach((element) => {
      getThreadIds(element).forEach(addId);
    });

  openThreads.map((thread) => thread.id).forEach(addId);
  return ids;
}

function getCurrentReviewThreadId(threadIds: string[]) {
  const activeThread = document.querySelector<HTMLElement>('.thread.is-active[data-thread-id]');
  const activeThreadId = activeThread?.getAttribute('data-thread-id') || '';

  if (threadIds.includes(activeThreadId)) {
    return activeThreadId;
  }

  const overlayThreadIds = commentOverlay.style.display === 'block'
    ? getThreadIds(commentOverlay)
    : [];
  const overlayThreadId = overlayThreadIds.find((threadId) => threadIds.includes(threadId));

  if (overlayThreadId) {
    return overlayThreadId;
  }

  const activeAnchor = markdownBody.querySelector<HTMLElement>('.is-active[data-thread-id]');
  const activeAnchorId = activeAnchor?.getAttribute('data-thread-id') || '';

  if (threadIds.includes(activeAnchorId)) {
    return activeAnchorId;
  }

  return '';
}

function updateReviewNavigation(currentThreadId?: string) {
  const threadIds = getReviewNavigationIds();
  const currentIndex = threadIds.indexOf(currentThreadId || getCurrentReviewThreadId(threadIds));
  const position = document.querySelector<HTMLElement>('[data-review-position]');
  if (position) {
    position.textContent = threadIds.length === 0
      ? 'No comments'
      : currentIndex >= 0
        ? String(currentIndex + 1) + ' of ' + String(threadIds.length)
        : String(threadIds.length) + (threadIds.length === 1 ? ' comment' : ' comments');
  }
  document.querySelectorAll<HTMLButtonElement>('[data-review-nav]').forEach((button) => {
    button.disabled = threadIds.length === 0;
  });
  document.querySelectorAll<HTMLButtonElement>('.thread [data-jump-thread]').forEach((button) => {
    const threadId = button.closest<HTMLElement>('.thread')?.getAttribute('data-thread-id');
    button.disabled = !findOverlaySourceElement(threadId);
    button.title = button.disabled ? 'The original text is unavailable in this document.' : 'Jump to this comment in the document.';
  });
}

function focusReviewElement(element: HTMLElement | null | undefined, shouldFocus = true) {
  if (!element) {
    return;
  }
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  element.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center', inline: 'nearest' });
  if (shouldFocus) {
    if (!element.matches('button, a[href], input, textarea, select, [tabindex]')) {
      element.setAttribute('tabindex', '-1');
    }
    element.focus({ preventScroll: true });
  }
}

function revealReviewThread(threadId: string) {
  if (!hideCommentOverlayIfClean()) {
    return;
  }
  const sourceElement = findOverlaySourceElement(threadId);

  if (!sourceElement) {
    setSidebarCollapsed(false);
    persistView();
    focusThread(threadId, true);
    return;
  }

  sourceElement.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'nearest' });
  const threadIds = getThreadIds(sourceElement);
  openCommentOverlay(threadIds.length > 0 ? threadIds : [threadId], sourceElement);
  focusThread(threadId, false);
}

function focusThread(threadId: string, shouldScroll: boolean) {
  document.querySelectorAll<HTMLElement>('.is-active').forEach((element) => element.classList.remove('is-active'));
  document.querySelectorAll<HTMLElement>('.thread[aria-current]').forEach((element) => element.removeAttribute('aria-current'));
  document.querySelectorAll<HTMLElement>('[data-thread-id="' + cssEscape(threadId) + '"]').forEach((element) => {
    element.classList.add('is-active');
  });
  const threadCard = document.querySelector<HTMLElement>('.thread[data-thread-id="' + cssEscape(threadId) + '"]');
  threadCard?.setAttribute('aria-current', 'true');
  updateReviewNavigation(threadId);

  if (!shouldScroll) {
    return;
  }

  focusReviewElement(reviewSidebar.hidden ? findOverlaySourceElement(threadId) : threadCard);
}

function focusAnchor(threadId: string | null | undefined) {
  if (!threadId) return;
  if (!hideCommentOverlayIfClean()) {
    return;
  }
  focusThread(threadId, false);
  const anchor = findOverlaySourceElement(threadId);

  if (anchor) {
    focusReviewElement(anchor);
    return;
  }

  const threadCard = document.querySelector<HTMLElement>('.thread[data-thread-id="' + cssEscape(threadId) + '"]');
  focusReviewElement(threadCard);
}

function shouldSkipHighlightParent(element: Element) {
  return Boolean(element.closest<HTMLElement>('button, textarea, .review-anchor, .comment-composer, .selection-popover, .comment-overlay, .mermaid-source, .mermaid-render'));
}

function isTextEntryTarget(element: EventTarget | null) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  return Boolean(element.closest<HTMLElement>('input, textarea, select, button, [contenteditable="true"], .block-editor, .mermaid-editor, .table-editor, .comment-composer, .comment-overlay'));
}

function normalizeInline(value: unknown) {
  return String(value).replace(/\s+/g, ' ').trim();
}

function looksLikeMermaidSource(value: string) {
  return /\b(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|pie|mindmap|timeline|gitGraph)\b/i.test(value);
}

function looksLikeMarkdownImageAnchor(value: string) {
  return /^!\[[^\]]*\]\(.+\)$/.test(String(value).trim());
}

function cssEscape(value: string) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\n\r\f]/g, character => '\\' + character.charCodeAt(0).toString(16) + ' ');
}

function scheduleSelectionComposer(openImmediately: boolean) {
  window.clearTimeout(selectionTimer);
  selectionTimer = window.setTimeout(() => {
    if (commentComposer.style.display === 'block') {
      return;
    }

    const hasSelection = captureCurrentSelection();

    if (!hasSelection) {
      hideSelectionPopover();
      clearDraftSelectionHighlight();
      return;
    }

    if (openImmediately) {
      openComposer();
    } else {
      positionFloatingElement(selectionPopover, activeSelectionRect, 120);
      selectionPopover.style.display = 'block';
    }
  }, openImmediately ? 80 : 160);
}

function updateSelectionPopover() {
  if (commentComposer.style.display === 'block') {
    return;
  }

  if (!captureCurrentSelection()) {
    hideSelectionPopover();
    clearDraftSelectionHighlight();
    return;
  }

  positionFloatingElement(selectionPopover, activeSelectionRect, 120);
  selectionPopover.style.display = 'block';
}

function captureCurrentSelection() {
  if (protectCommentDraft()) return false;
  const selection = window.getSelection();

  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return false;
  }

  const selectedText = String(selection).trim();

  if (!selectedText) {
    return false;
  }

  const range = selection.getRangeAt(0);
  const container = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
    ? range.commonAncestorContainer
    : range.commonAncestorContainer.parentElement;

  if (!(container instanceof HTMLElement) || !markdownBody.contains(container)) {
    return false;
  }

  const rect = getBestSelectionRect(range);

  if (!rect || rect.width === 0 && rect.height === 0) {
    return false;
  }

  activeSelectionText = selectedText;
  activeSelectionOccurrence = countPriorOccurrences(range, selectedText);
  const selectionLineRange = getSelectionSourceLineRange(range, container);
  activeSourceLine = selectionLineRange?.lineStart ?? getSourceLine(container);
  activeSourceLineEnd = selectionLineRange?.lineEnd ?? getSourceLineEnd(container);
  activeSelectionRect = {
    left: rect.left,
    right: rect.right,
    top: rect.top,
    bottom: rect.bottom
  };
  setDraftSelectionHighlight(range);

  return true;
}

function getSelectionSourceLineRange(range: Range, container: HTMLElement) {
  const sourceElements = Array.from(markdownBody.querySelectorAll<HTMLElement>('[data-source-line]'))
    .filter((element) => !shouldSkipHighlightParent(element) && selectionIntersectsElement(range, element));

  if (sourceElements.length === 0 && container instanceof HTMLElement) {
    const lineStart = getSourceLine(container);

    if (!lineStart) {
      return undefined;
    }

    return {
      lineStart,
      lineEnd: Math.max(lineStart, getSourceLineEnd(container) ?? lineStart)
    };
  }

  const ranges = sourceElements
    .map((element) => {
      const lineStart = getSourceLine(element);

      if (!lineStart) {
        return undefined;
      }

      return {
        lineStart,
        lineEnd: Math.max(lineStart, getSourceLineEnd(element) ?? lineStart)
      };
    })
    .filter(isPresent);

  if (ranges.length === 0) {
    return undefined;
  }

  return {
    lineStart: Math.min(...ranges.map((lineRange) => lineRange.lineStart)),
    lineEnd: Math.max(...ranges.map((lineRange) => lineRange.lineEnd))
  };
}

function selectionIntersectsElement(range: Range, element: Element) {
  try {
    return range.intersectsNode(element);
  } catch {
    const elementRange = document.createRange();
    elementRange.selectNodeContents(element);
    return range.compareBoundaryPoints(Range.END_TO_START, elementRange) < 0
      && range.compareBoundaryPoints(Range.START_TO_END, elementRange) > 0;
  }
}

function countPriorOccurrences(range: Range, selectedText: string) {
  const needle = normalizeInline(selectedText);

  if (!needle) {
    return 0;
  }

  const priorRange = range.cloneRange();
  priorRange.selectNodeContents(markdownBody);
  priorRange.setEnd(range.startContainer, range.startOffset);
  return countOccurrences(normalizeInline(priorRange.toString()), needle);
}

function countOccurrences(haystack: string, needle: string) {
  let count = 0;
  let index = haystack.indexOf(needle);

  while (index >= 0) {
    count += 1;
    index = haystack.indexOf(needle, index + Math.max(1, needle.length));
  }

  return count;
}

function getBestSelectionRect(range: Range) {
  const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 || rect.height > 0);

  if (rects.length > 0) {
    return rects[rects.length - 1];
  }

  return range.getBoundingClientRect();
}

function setDraftSelectionHighlight(range: Range) {
  activeSelectionRange = range.cloneRange();
  renderDraftSelectionHighlight();
}

function clearDraftSelectionHighlight() {
  activeSelectionRange = null;
  clearDraftSelectionCustomHighlight();
  draftSelectionHighlightLayer.replaceChildren();
  draftSelectionHighlightLayer.hidden = true;
}

function renderDraftSelectionHighlight() {
  if (!activeSelectionRange) {
    clearDraftSelectionHighlight();
    return;
  }

  if (supportsDraftSelectionCustomHighlight()) {
    draftSelectionHighlightLayer.replaceChildren();
    draftSelectionHighlightLayer.hidden = true;
    window.CSS.highlights.set('ai-review-draft-selection', new window.Highlight(activeSelectionRange));
    return;
  }

  renderDraftSelectionFallbackHighlight();
}

function renderDraftSelectionFallbackHighlight() {
  if (!activeSelectionRange || supportsDraftSelectionCustomHighlight()) {
    draftSelectionHighlightLayer.replaceChildren();
    draftSelectionHighlightLayer.hidden = true;
    return;
  }

  const rects = Array.from(activeSelectionRange.getClientRects())
    .filter((rect) => rect.width > 0 && rect.height > 0);
  draftSelectionHighlightLayer.replaceChildren(...rects.map((rect) => {
    const element = document.createElement('span');
    element.className = 'draft-selection-highlight-rect';
    element.style.left = rect.left + 'px';
    element.style.top = rect.top + 'px';
    element.style.width = rect.width + 'px';
    element.style.height = rect.height + 'px';
    return element;
  }));
  draftSelectionHighlightLayer.hidden = rects.length === 0;
}

function supportsDraftSelectionCustomHighlight() {
  return typeof window.Highlight === 'function'
    && Boolean(window.CSS?.highlights?.set)
    && Boolean(window.CSS?.highlights?.delete);
}

function clearDraftSelectionCustomHighlight() {
  if (supportsDraftSelectionCustomHighlight()) {
    window.CSS.highlights.delete('ai-review-draft-selection');
  }
}

function openCommentEditor(thread: ReviewThread) {
  if (!trusted) return;
  if (protectCommentDraft()) return;
  hideCommentOverlay();
  activeCommentEdit = { threadId: thread.id, revision: thread.taskRevision, originalComment: thread.comment };
  activeSelectionText = thread.anchor.text;
  activeSelectionOccurrence = thread.anchor.occurrence || 0;
  activeSourceLine = thread.anchor.lineStart;
  activeSourceLineEnd = thread.anchor.lineEnd;
  commentBody.value = thread.comment;
  commentComposer.querySelector<HTMLElement>('.comment-composer-label')!.textContent = 'Edit change request';
  commentComposer.style.display = 'block';
  commentComposer.style.left = '16px';
  commentComposer.style.top = '48px';
  clampFloatingElement(commentComposer);
  commentBody.focus();
}

function protectCommentDraft() {
  if (draftSession && !draftSession.canOpen('comment')) return true;
  if (commentComposer.style.display === 'block' && commentBody.value.trim()) {
    commentBody.focus();
    return true;
  }
  return false;
}

function openComposer() {
  if (!trusted) return;
  if (protectCommentDraft()) return;
  if (!activeSelectionText || !activeSelectionRect) {
    return;
  }

  if (!hideCommentOverlayIfClean()) {
    return;
  }
  hideSelectionPopover();
  activeCommentEdit = undefined;
  commentComposer.querySelector<HTMLElement>('.comment-composer-label')!.textContent = 'Add a change request for the selection';
  commentBody.value = '';
  updateCommentQualityWarning();
  renderDraftSelectionHighlight();
  positionFloatingElement(commentComposer, activeSelectionRect, 340);
  commentComposer.style.display = 'block';
  commentBody.focus();
}

function hideSelectionPopover() {
  selectionPopover.style.display = 'none';
}

function hideComposer() {
  if (commentComposer.getAttribute('aria-busy') === 'true') return;
  commentComposer.style.display = 'none';
  activeCommentEdit = undefined;
  commentBody.value = '';
  updateCommentQualityWarning();
  clearDraftSelectionHighlight();
}

function hideComposerIfEmpty(target?: Element) {
  if (commentComposer.style.display !== 'block') {
    return;
  }

  if (target?.closest?.('.comment-composer, .selection-popover')) {
    return;
  }

  if (commentBody.value.trim()) {
    return;
  }

  hideComposer();
}

function updateCommentQualityWarning() {
  const warning = commentQualityWarningText(commentBody.value);

  if (!warning || !commentBody.value.trim()) {
    commentQualityWarning.hidden = true;
    commentQualityWarning.textContent = '';
    return;
  }

  commentQualityWarning.hidden = false;
  commentQualityWarning.textContent = 'Review request hint: ' + warning;
}

function commentQualityWarningText(comment: string) {
  const normalized = String(comment || '').trim().replace(/\s+/g, ' ');

  if (!normalized) {
    return 'Comment is empty, so an AI agent has no actionable instruction.';
  }

  if (normalized.length < 8) {
    return 'Comment is short; add the expected action or reason so the agent can apply it safely.';
  }

  if (!/[\p{L}\p{N}]/u.test(normalized)) {
    return 'Comment has no readable words or numbers; add a concrete action or question.';
  }

  if (/:$/.test(normalized) || /\bbecause$/i.test(normalized)) {
    return 'Comment looks unfinished; finish the reason, decision, or requested action.';
  }

  return '';
}

function positionFloatingElement(element: HTMLElement, rect: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'> | null, preferredWidth: number) {
  if (!rect) return;
  const previousDisplay = element.style.display;
  // Hidden panels have no measurable height. Measure the complete panel,
  // including its toolbar/actions, before clamping it to the webview viewport.
  element.style.display = 'block';
  element.style.left = (rect.right + 8) + 'px';
  element.style.top = (rect.top - 4) + 'px';
  clampFloatingElement(element, preferredWidth);
  element.style.display = previousDisplay;
}

function clampFloatingElement(element: HTMLElement, fallbackWidth = 0) {
  const margin = 12;
  const bounds = element.getBoundingClientRect();
  const width = bounds.width || Math.min(fallbackWidth, window.innerWidth - margin * 2);
  const left = Number.parseFloat(element.style.left) || margin;
  const top = Number.parseFloat(element.style.top) || margin;
  element.style.left = Math.max(margin, Math.min(left, window.innerWidth - width - margin)) + 'px';
  element.style.top = Math.max(margin, Math.min(top, window.innerHeight - bounds.height - margin)) + 'px';
}

async function renderMermaidDiagrams() {
  const mermaidApi = window.mermaid;
  const containers = Array.from(document.querySelectorAll<HTMLElement>('[data-mermaid-render]'));

  if (containers.length === 0) {
    return;
  }

  if (!mermaidApi) {
    for (const container of containers) {
      showMermaidError(container, 'Mermaid runtime did not load.', container.textContent || '');
    }
    return;
  }

  const isDark = document.body.classList.contains('vscode-dark')
    || document.body.classList.contains('vscode-high-contrast');

  mermaidApi.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: isDark ? 'dark' : 'default',
    flowchart: {
      htmlLabels: false,
      useMaxWidth: true
    },
    sequence: {
      useMaxWidth: true
    },
    gantt: {
      useMaxWidth: true
    }
  });

  for (const [index, container] of containers.entries()) {
    const source = String(container.textContent || '').trim();

    try {
      const id = 'amrl-mermaid-' + index + '-' + Date.now();
      const result = await mermaidApi.render(id, source);
      container.classList.remove('is-error');
      container.innerHTML = result.svg;
      result.bindFunctions?.(container);
    } catch (error) {
      showMermaidError(container, error instanceof Error ? error.message : String(error), source);
    }
  }
}

function showMermaidError(container: HTMLElement, message: string, source: string) {
  container.classList.add('is-error');
  container.innerHTML = [
    '<strong>Mermaid render error</strong>',
    '<pre>' + escapeHtml(message) + '</pre>',
    '<details open>',
    '<summary>Diagram source</summary>',
    '<pre><code>' + escapeHtml(source) + '</code></pre>',
    '</details>'
  ].join('');
}



function setSidebarCollapsed(collapsed: boolean): void {
  viewState.sidebarCollapsed = collapsed;
  reviewSidebar.hidden = collapsed;
  document.querySelector<HTMLElement>('.layout')?.classList.toggle('sidebar-collapsed', collapsed);
  document.querySelectorAll<HTMLElement>('[data-toggle-sidebar]').forEach(toggle => {
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.textContent = collapsed ? 'Show comments' : 'Hide comments';
  });
}

function setEditDocumentMode(enabled: boolean): void {
  if (!canEditMarkdown) enabled = false;
  if (!enabled && (isBlockEditorDirty() || (activeMermaidEdit && mermaidEditorSource.value !== activeMermaidEdit.originalSource)
    || (activeTableEdit && tableEditorSignature() !== activeTableEdit.originalSignature))) return;
  viewState.editDocument = enabled;
  document.body.classList.toggle('edit-document-mode', enabled);
  if (enabled) decorateEditableMarkdownBlocks();
  else markdownBody.querySelectorAll<HTMLElement>('.editable-markdown-block > .block-edit-actions').forEach(element => element.remove());
  markdownBody.querySelectorAll<HTMLElement>('[data-mermaid-edit], [data-source-edit-control], .mermaid-source').forEach(element => {
    element.hidden = !enabled || Boolean(element.closest<HTMLElement>('li, blockquote'));
  });
  const toggle = document.querySelector<HTMLButtonElement>('[data-toggle-edit-document]');
  if (toggle) {
    toggle.setAttribute('aria-pressed', String(enabled));
    toggle.textContent = enabled ? 'Finish editing' : 'Edit document';
    toggle.disabled = !canEditMarkdown;
  }
  if (!enabled) { hideBlockEditorIfClean(); hideMermaidEditorIfClean(); hideTableEditorIfClean(); }
}

function persistView(): void {
  const current = vscode.getState();
  vscode.setState({ schema: 1, documentUri: state.documentUri, drafts: current?.documentUri === state.documentUri ? current.drafts || {} : {}, view: viewState });
}

function restoreReadingPosition(): void {
  reviewSidebar.scrollTop = viewState.sidebarScrollTop || 0;
  if (!restoreState.focusThreadId) {
    window.scrollTo?.({ top: viewState.scrollY || 0, behavior: 'instant' });
    if (viewState.focusId) document.getElementById(viewState.focusId)?.focus({ preventScroll: true });
  }
}

window.addEventListener('scroll', () => {
  viewState.scrollY = window.scrollY || 0;
  persistView();
}, { passive: true });
reviewSidebar.addEventListener('scroll', () => {
  viewState.sidebarScrollTop = reviewSidebar.scrollTop;
  persistView();
}, { passive: true });
document.addEventListener('focusin', event => {
  if (event.target instanceof HTMLElement) { viewState.focusId = event.target.id || undefined; persistView(); }
});

window.addEventListener('message', event => {
  const message = readHostMessage(event.data);
  if (message?.type !== 'reviewStateUpdated') return;
  const next = message.state;
  if (next.previewId !== state.previewId || next.documentUri !== state.documentUri || next.documentVersion !== documentVersion) return;
  document.getElementById('review-refresh-error')?.remove();
  draftSession?.collect();
  const activeId = getCurrentReviewThreadId(getReviewNavigationIds());
  const overlayIds = commentOverlay.style.display === 'block' ? getThreadIds(commentOverlay) : [];
  hideCommentOverlay();
  markdownBody.querySelectorAll<HTMLElement>('.review-badge').forEach(element => element.remove());
  markdownBody.querySelectorAll<HTMLElement>('.review-anchor').forEach(element => {
    element.replaceWith(...Array.from(element.childNodes));
  });
  markdownBody.querySelectorAll<HTMLElement>('[data-thread-id]').forEach(element => {
    element.removeAttribute('data-thread-id'); element.removeAttribute('data-thread-ids');
    element.classList.remove('review-anchor-block', 'has-review', 'anchor-exact', 'anchor-recovered', 'anchor-approximate', 'anchor-missing', 'is-active');
  });
  markdownBody.normalize();
  Object.assign(state, next);
  restoreState = next.restoreState || {};
  openThreads = state.threads.filter(thread => thread.status === 'open');
  renderComments();
  const copy = document.querySelector<HTMLButtonElement>('[data-copy-review-json]');
  if (copy) copy.disabled = !trusted || openThreads.length === 0;
  const notice = document.querySelector<HTMLElement>('.review-file-status');
  if (notice) notice.hidden = state.reviewFileState !== 'removed';
  draftSession?.refresh();
  if (restoreState.focusThreadId) restorePreviewState();
  else if (activeId && findThread(activeId)) {
    focusThread(activeId, false);
    if (overlayIds.includes(activeId)) {
      const source = findOverlaySourceElement(activeId);
      if (source) openCommentOverlay(overlayIds.filter(id => findThread(id)), source);
    }
  }
});

// Textarea resizing, draft status and table rows can grow a visible panel.
if (typeof window.ResizeObserver === 'function') {
  const panelObserver = new ResizeObserver(entries => {
    for (const { target } of entries) {
      if (target instanceof HTMLElement && target.style.display === 'block') clampFloatingElement(target);
    }
  });
  document.querySelectorAll('.selection-popover, .comment-composer, .comment-overlay, .block-editor, .mermaid-editor, .table-editor')
    .forEach(element => panelObserver.observe(element));
}

// Notify the host only after every state/draft listener is installed.
postReviewMessage({ type: 'webviewReady', previewId: state.previewId });
