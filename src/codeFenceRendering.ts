export function renderReviewableCodeFence(
  source: string,
  info = '',
  zeroBasedSourceLine?: number,
  zeroBasedEndLine?: number
): string {
  const language = info.trim().split(/\s+/)[0] || '';
  const classAttribute = language
    ? ` class="language-${escapeHtmlAttribute(language)}"`
    : '';
  const sourceLine = typeof zeroBasedSourceLine === 'number'
    ? ` data-source-line="${zeroBasedSourceLine + 1}"`
    : '';
  const sourceLineEnd = typeof zeroBasedEndLine === 'number'
    ? ` data-source-line-end="${zeroBasedEndLine}"`
    : '';

  return `<pre class="review-code-fence" data-review-code-fence${sourceLine}${sourceLineEnd}><code${classAttribute}>${escapeHtml(source)}</code></pre>\n`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value)
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
