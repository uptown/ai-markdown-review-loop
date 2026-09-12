const vscode = acquireVsCodeApi();
document.getElementById('retry-preview')?.addEventListener('click', () => vscode.postMessage({type:'refreshPreview'}));
const stored = vscode.getState?.();
if (stored?.schema === 1 && stored.documentUri === window.reviewInitialState.documentUri && stored.drafts) {
  const container = document.getElementById('error-drafts');
  if (!container) throw new Error('Missing draft recovery container.');
  for (const [key, draft] of Object.entries(stored.drafts) as Array<[string, Record<string, any>]>) {
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
    copy.disabled = window.reviewInitialState.trusted === false;
    copy.addEventListener('click', () => vscode.postMessage({type:'copyDraft',...payload}));
    const discard = document.createElement('button');
    discard.type = 'button'; discard.textContent = 'Discard draft';
    discard.addEventListener('click', () => {delete stored.drafts[key];vscode.setState?.(stored);item.remove();});
    item.append(label, input, copy, discard);
    container.appendChild(item);
  }
}
