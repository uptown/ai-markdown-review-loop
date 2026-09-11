export function renderReanchorPanel(): string {
  return `<section id="review-reanchor" aria-label="Reattach review thread" hidden style="position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:1200;width:min(640px,calc(100vw - 32px));box-sizing:border-box;padding:16px;border:1px solid var(--border);border-radius:8px;background:var(--panel);box-shadow:0 6px 24px #0005;max-height:40vh;overflow:auto">
    <strong>Reattach review thread</strong>
    <p id="review-reanchor-comment" style="margin:8px 0;white-space:pre-wrap"></p>
    <p id="review-reanchor-status" role="status" aria-live="polite">Select the new target text in the Markdown preview.</p>
    <blockquote id="review-reanchor-selection" style="white-space:pre-wrap;max-height:100px;overflow:auto"></blockquote>
    <button type="button" id="review-reanchor-confirm" disabled>Attach to this selection</button>
    <button type="button" id="review-reanchor-cancel" class="secondary">Cancel</button>
  </section>`;
}

/** Injected after the main preview script so existing selection and draft safeguards stay authoritative. */
export function renderReanchorScript(): string {
  return String.raw`
    (() => {
      const panel = document.getElementById('review-reanchor');
      const comment = document.getElementById('review-reanchor-comment');
      const status = document.getElementById('review-reanchor-status');
      const selectionPreview = document.getElementById('review-reanchor-selection');
      const confirm = document.getElementById('review-reanchor-confirm');
      const cancel = document.getElementById('review-reanchor-cancel');
      let targetThread;
      let selectedTarget;
      let pendingRequest = '';
      let returnFocus;

      function dirtyDraft() {
        if (commentBody.value.trim()) return commentBody;
        if (activeBlockEdit && isBlockEditorDirty()) return isBlockEditorRawMode() ? blockEditorRaw : blockEditorSurface;
        if (activeMermaidEdit && mermaidEditorSource.value !== activeMermaidEdit.originalSource) return mermaidEditorSource;
        if (activeTableEdit && tableEditorSignature() !== activeTableEdit.originalSignature) return tableEditorGrid.querySelector('input');
        return undefined;
      }

      function finish() {
        if (pendingRequest) return;
        targetThread = undefined;
        selectedTarget = undefined;
        panel.hidden = true;
        selectionPreview.textContent = '';
        confirm.disabled = true;
        clearDraftSelectionHighlight();
        returnFocus?.focus();
      }

      function begin(thread, button) {
        if (pendingRequest || isHandoffActive()) return;
        const dirty = dirtyDraft();
        panel.hidden = false;
        returnFocus = button;
        comment.textContent = thread.comment + '\nCurrent target: ' + thread.anchor.text;
        selectionPreview.textContent = '';
        confirm.disabled = true;
        if (dirty) {
          targetThread = undefined;
          status.textContent = 'Finish or cancel your current draft before reattaching this thread. Your draft has been kept.';
          dirty.focus();
          return;
        }
        targetThread = thread;
        selectedTarget = undefined;
        window.clearTimeout(selectionTimer);
        hideSelectionPopover();
        hideComposerIfEmpty();
        hideBlockEditorIfClean();
        hideMermaidEditorIfClean();
        hideTableEditorIfClean();
        hideCommentOverlayIfClean();
        status.textContent = 'Select the new target text in the Markdown preview, then confirm below. The Markdown will be kept and the request revision will advance.';
        cancel.focus();
      }

      for (const thread of openThreads) {
        const card = document.querySelector('.thread[data-thread-id="' + cssEscape(thread.id) + '"]:not(.is-closed)');
        const actions = card?.querySelector('.thread-actions');
        if (!actions) continue;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'secondary';
        button.textContent = 'Reattach';
        button.disabled = isHandoffActive();
        button.title = 'Choose new target text for this existing thread without changing the Markdown.';
        button.setAttribute('data-reanchor-thread', thread.id);
        button.addEventListener('click', event => {
          event.stopPropagation();
          begin(thread, button);
        });
        actions.appendChild(button);
      }

      function captureSelection(event) {
        if (!targetThread || pendingRequest || isHandoffActive()) return;
        event.stopImmediatePropagation();
        window.clearTimeout(selectionTimer);
        hideSelectionPopover();
        if (dirtyDraft()) {
          confirm.disabled = true;
          status.textContent = 'Finish or cancel your current draft before selecting a new review location. Your draft has been kept.';
          return;
        }
        if (!captureCurrentSelection()) return;
        const range = window.getSelection()?.getRangeAt(0);
        if (!range) return;
        selectedTarget = {
          anchorText: activeSelectionText,
          sourceLine: activeSourceLine,
          sourceLineEnd: activeSourceLineEnd || activeSourceLine,
          contextBefore: range.startContainer.nodeType === Node.TEXT_NODE
            ? String(range.startContainer.nodeValue || '').slice(0, range.startOffset).slice(-80) : '',
          contextAfter: range.endContainer.nodeType === Node.TEXT_NODE
            ? String(range.endContainer.nodeValue || '').slice(range.endOffset, range.endOffset + 80) : ''
        };
        selectionPreview.textContent = selectedTarget.anchorText;
        confirm.disabled = !selectedTarget.sourceLine || !selectedTarget.sourceLineEnd;
        status.textContent = confirm.disabled
          ? 'Select text inside a Markdown block with a known source location.'
          : 'Attach this existing thread to the selected text? Its ID will be preserved and the request will stay pending.';
      }

      document.addEventListener('selectionchange', captureSelection, true);
      markdownBody.addEventListener('pointerup', captureSelection, true);
      markdownBody.addEventListener('keyup', captureSelection, true);
      document.addEventListener('keydown', event => {
        if (panel.hidden) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopImmediatePropagation();
          finish();
        } else if (targetThread && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
          // Preserve native keyboard text selection while pausing review navigation.
          event.stopImmediatePropagation();
        }
      }, true);
      cancel.addEventListener('click', finish);
      confirm.addEventListener('click', () => {
        if (!targetThread || !selectedTarget || pendingRequest || isHandoffActive()) return;
        const dirty = dirtyDraft();
        if (dirty) {
          status.textContent = 'Finish or cancel your current draft before saving this reattachment. Your draft has been kept.';
          dirty.focus();
          return;
        }
        pendingRequest = 'reanchor-' + Date.now() + '-' + Math.random().toString(16).slice(2);
        confirm.disabled = true;
        cancel.disabled = true;
        status.textContent = 'Saving the new review location…';
        postReviewMessage({ type: 'reanchorThread', requestId: pendingRequest, threadId: targetThread.id,
          anchorIdentity: anchorIdentityByThreadId[targetThread.id], ...selectedTarget });
      });
      window.addEventListener('message', event => {
        const message = event.data;
        if (message?.type === 'handoffPhase') {
          confirm.disabled = isHandoffActive() || !selectedTarget || Boolean(pendingRequest);
          if (isHandoffActive() && !panel.hidden) status.textContent = 'Handed off to the agent · reattachment is paused.';
          return;
        }
        if (message?.type !== 'reviewMutationResult' || message.requestId !== pendingRequest || !pendingRequest) return;
        pendingRequest = '';
        cancel.disabled = false;
        if (message.ok) {
          finish();
        } else {
          status.textContent = message.error || 'The thread could not be reattached. Your selection has been kept; retry or select different text.';
          confirm.disabled = isHandoffActive() || !selectedTarget;
        }
      });
    })();
  `;
}
