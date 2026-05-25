import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import MarkdownIt from 'markdown-it';
import { applySourceLineMapping } from '../src/sourceMappedMarkdown';

describe('source-mapped Markdown rendering', () => {
  it('adds source line ranges to ordered list containers for multiline list selections', () => {
    const markdown = [
      '# Header with target words',
      '',
      '1. First target words',
      '2. Second target words',
      '3. Third target words'
    ].join('\n');

    assert.match(
      render(markdown),
      /<ol data-source-line="3" data-source-line-end="5">/
    );
  });

  it('adds source line ranges to unordered list containers', () => {
    const markdown = [
      'Intro',
      '',
      '- Alpha',
      '- Beta'
    ].join('\n');

    assert.match(
      render(markdown),
      /<ul data-source-line="3" data-source-line-end="4">/
    );
  });
});

function render(markdown: string): string {
  const markdownIt = new MarkdownIt();
  applySourceLineMapping(markdownIt);
  return markdownIt.render(markdown);
}
