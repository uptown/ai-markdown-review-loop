// This script runs in the generated webview's lexical scope. Keep browser-only
// behavior here; provider and DOM integration tests execute the emitted script.
export function renderWebviewDraftScript(): string {
  return String.raw`
    draftSession = (() => {
      const supported = new Set(['addComment', 'editComment', 'editMarkdownBlock', 'insertMarkdownBlock', 'editMermaidSource', 'editMarkdownTable']);
      const stored = vscode.getState?.();
      const drafts = stored?.schema === 1 && stored.documentUri === state.documentUri
        && stored.drafts && typeof stored.drafts === 'object' ? stored.drafts : {};
      const pendingForms = new Map();
      const recovery = document.createElement('section');
      recovery.className = 'draft-recovery';
      recovery.setAttribute('aria-label', 'Recovered drafts');
      markdownBody.before(recovery);
      let restoring = true;

      function keyFor(message) {
        if (message.type === 'addComment' || message.type === 'editComment') return 'comment';
        if (message.type === 'editMermaidSource') return 'mermaid';
        if (message.type === 'editMarkdownTable') return 'table';
        return 'block';
      }

      function formFor(key) {
        if (key === 'comment') return commentComposer;
        if (key === 'block') return blockEditor;
        if (key === 'mermaid') return mermaidEditor;
        if (key === 'table') return tableEditor;
        return undefined;
      }

      function formsFor(key) { return [formFor(key)].filter(Boolean); }

      function visible(form) { return form?.style.display === 'block'; }
      function persist() {
        if (restoring) return;
        vscode.setState?.({ schema: 1, documentUri: state.documentUri, drafts });
      }

      function remember(key, data) {
        if (drafts[key]?.requestId || drafts[key]?.recovery) return;
        if (!data) { delete drafts[key]; return; }
        drafts[key] = { ...drafts[key], ...data, fingerprint: state.sourceFingerprint };
      }

      function collect(forceKey) {
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

      function status(form, text) {
        if (!form) return;
        let element = form.querySelector('[data-save-status]');
        if (!element) {
          element = document.createElement('p');
          element.setAttribute('data-save-status', '');
          element.setAttribute('role', 'status');
          element.setAttribute('aria-live', 'polite');
          form.appendChild(element);
        }
        element.textContent = text;
      }

      function freeze(form, saving) {
        if (!form) return;
        form.setAttribute('aria-busy', saving ? 'true' : 'false');
        if (saving) {
          if (pendingForms.has(form)) return;
          const controls = Array.from(form.querySelectorAll('input, textarea, button, select, [contenteditable]'));
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

      function clear(key, close) {
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

      function acceptResult(message) {
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

      function submit(message) {
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
      function safeHtml(html) {
        const container = document.createElement('div');
        container.innerHTML = String(html || '');
        container.querySelectorAll('script, style, iframe, object, embed, link, meta, base, form, input, button').forEach(element => element.remove());
        container.querySelectorAll('*').forEach(element => {
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

      function restoreDraft(key, draft) {
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
          commentComposer.querySelector('.comment-composer-label').textContent = draft.edit ? 'Edit change request' : 'Add a change request for the selection';
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
      }

      function copyPayload(draft) {
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
        if (event.data?.type === 'reviewMutationResult') acceptResult(event.data);
        if (event.data?.type === 'reviewRefreshFailed') {
          let notice = document.getElementById('review-refresh-error');
          if (!notice) {
            notice = document.createElement('section');
            notice.id = 'review-refresh-error'; notice.className = 'draft-recovery';
            notice.setAttribute('role', 'alert');
            markdownBody.before(notice);
          }
          notice.replaceChildren();
          const text = document.createElement('p');
          text.textContent = 'Preview could not refresh. Your drafts are kept. ' + String(event.data.error || '');
          const retry = document.createElement('button');
          retry.type = 'button'; retry.textContent = 'Retry refresh';
          retry.addEventListener('click', () => postReviewMessage({type:'refreshPreview'}));
          notice.append(text, retry);
          collect();
        }
      });
      for (const [button, key] of [[commentCancel, 'comment'], [blockEditorCancel, 'block'], [mermaidEditorCancel, 'mermaid'], [tableEditorCancel, 'table']]) {
        button.addEventListener('click', () => { clear(key, false); showRecovery(); });
      }
      return { submit, collect, canOpen(key) {
        if (!drafts[key]?.requestId && !drafts[key]?.recovery) return true;
        if (drafts[key]?.recovery) {
          recovery.scrollIntoView({block:'center'});
          recovery.querySelector('textarea')?.focus();
        } else status(formFor(key), 'Saving… Wait for confirmation before opening another target.');
        return false;
      } };
    })();
  `;
}

/** Read-only recovery still works when the sidecar prevents the first preview render. */
export function renderErrorDraftScript(documentUri: string): string {
  const uri = JSON.stringify(documentUri).replace(/</g, '\\u003c');
  return String.raw`
    const vscode = acquireVsCodeApi();
    document.getElementById('retry-preview').addEventListener('click', () => vscode.postMessage({type:'refreshPreview'}));
    const stored = vscode.getState?.();
    if (stored?.schema === 1 && stored.documentUri === ${uri} && stored.drafts) {
      const container = document.getElementById('error-drafts');
      for (const [key, draft] of Object.entries(stored.drafts)) {
        if (!draft || typeof draft !== 'object') continue;
        const item = document.createElement('section');
        const label = document.createElement('p');
        label.textContent = 'Unsaved ' + draft.kind + ' draft. Check the document or thread before pasting if a save was interrupted.';
        let payload;
        if (draft.kind === 'block') payload = draft.rawMode ? {text:draft.raw} : {html:draft.html,sourceMarkdown:draft.edit?.originalRawMarkdown || ''};
        else if (draft.kind === 'table') payload = {table:draft.table};
        else payload = {text:draft.text || ''};
        const input = document.createElement('textarea');
        input.readOnly = true;
        input.setAttribute('aria-label', 'Recovered ' + draft.kind + ' draft');
        if (payload.html) {
          const parsed = document.createElement('div'); parsed.innerHTML = payload.html;
          parsed.querySelectorAll('script,style,iframe,object,embed').forEach(node => node.remove());
          input.value = parsed.textContent;
        } else input.value = payload.text || JSON.stringify(payload.table, null, 2);
        const copy = document.createElement('button');
        copy.type = 'button'; copy.textContent = 'Copy draft';
        copy.addEventListener('click', () => vscode.postMessage({type:'copyDraft',...payload}));
        const discard = document.createElement('button');
        discard.type = 'button'; discard.textContent = 'Discard draft';
        discard.addEventListener('click', () => {delete stored.drafts[key];vscode.setState?.(stored);item.remove();});
        item.append(label, input, copy, discard);
        container.appendChild(item);
      }
    }
  `;
}
