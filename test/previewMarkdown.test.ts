import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import MarkdownIt from 'markdown-it';
import { createPreviewMarkdown } from '../src/previewMarkdown';

describe('preview Markdown', () => {
  it('hides YAML front matter before rendering the review preview', () => {
    const markdown = [
      '---',
      'title: Review Loop',
      'tags:',
      '  - review',
      '---',
      '# Title',
      'Body'
    ].join('\n');

    const previewMarkdown = createPreviewMarkdown(markdown);

    assert.equal(previewMarkdown, '\n\n\n\n\n# Title\nBody');
    assert.doesNotMatch(render(previewMarkdown), /title: Review Loop|tags:|review/);
  });

  it('keeps rendered source line numbers aligned with the original Markdown', () => {
    const markdown = [
      '---',
      'title: Review Loop',
      '---',
      '# Title',
      'Body'
    ].join('\n');

    assert.match(render(createPreviewMarkdown(markdown)), /<h1 data-source-line="4">Title<\/h1>/);
  });

  it('does not hide a top-level thematic break without a closing front matter delimiter', () => {
    const markdown = [
      '---',
      '',
      '# Title'
    ].join('\n');

    assert.equal(createPreviewMarkdown(markdown), markdown);
  });

  it('preserves CRLF line endings and supports YAML ellipsis closing delimiters', () => {
    const markdown = [
      '---',
      'title: Review Loop',
      '...',
      '# Title'
    ].join('\r\n');

    assert.equal(createPreviewMarkdown(markdown), '\r\n\r\n\r\n# Title');
  });
});

function render(markdown: string): string {
  const markdownIt = new MarkdownIt();
  const defaultHeadingOpen = markdownIt.renderer.rules.heading_open;

  markdownIt.renderer.rules.heading_open = (tokens, index, options, env, self) => {
    const sourceLine = tokens[index].map?.[0];

    if (typeof sourceLine === 'number') {
      tokens[index].attrSet('data-source-line', String(sourceLine + 1));
    }

    if (defaultHeadingOpen) {
      return defaultHeadingOpen(tokens, index, options, env, self);
    }

    return self.renderToken(tokens, index, options);
  };

  return markdownIt.render(markdown);
}
