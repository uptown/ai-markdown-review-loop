import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { htmlBlockToMarkdown } from '../src/htmlToMarkdown';

describe('htmlBlockToMarkdown', () => {
  it('converts common rich text blocks to Markdown', () => {
    const markdown = htmlBlockToMarkdown('<p>Use <strong>clear</strong> and <em>small</em> steps.</p>');

    assert.equal(markdown, 'Use **clear** and *small* steps.');
  });

  it('keeps heading and blockquote structure', () => {
    assert.equal(htmlBlockToMarkdown('<h2>Decision</h2>'), '## Decision');
    assert.equal(htmlBlockToMarkdown('<blockquote><p>Keep the audit trail.</p></blockquote>'), '> Keep the audit trail.');
  });

  it('maps contenteditable monospace formatting to inline code', () => {
    assert.equal(htmlBlockToMarkdown('<p>Run <font face="monospace">npm run check</font>.</p>'), 'Run `npm run check`.');
  });

  it('normalizes excessive blank lines from edited blocks', () => {
    assert.equal(htmlBlockToMarkdown('<p>First</p><p><br></p><p>Second</p>'), 'First\n\nSecond');
  });
});
