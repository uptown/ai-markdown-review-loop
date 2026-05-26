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
    assert.equal(htmlBlockToMarkdown('<p>Run <code>npm run package</code>.</p>'), 'Run `npm run package`.');
  });

  it('normalizes excessive blank lines from edited blocks', () => {
    assert.equal(htmlBlockToMarkdown('<p>First</p><p><br></p><p>Second</p>'), 'First\n\nSecond');
  });

  it('drops empty invisible inline elements without joining surrounding words', () => {
    assert.equal(
      htmlBlockToMarkdown('<p>Use <a href="/ghost"></a> visible text <i></i>here.</p>'),
      'Use visible text here.'
    );
  });

  it('keeps fenced code block language metadata from common class names', () => {
    assert.equal(
      htmlBlockToMarkdown('<pre><code class="lang-ts">const value = 1;\nconsole.log(value);</code></pre>'),
      ['```ts', 'const value = 1;', 'console.log(value);', '```'].join('\n')
    );
  });

  it('uses a longer code fence and leaves code whitespace untouched when needed', () => {
    assert.equal(
      htmlBlockToMarkdown('<pre><code class="language-md">```js\n-   keep spacing\n```</code></pre>'),
      ['````md', '```js', '-   keep spacing', '```', '````'].join('\n')
    );
  });

  it('converts pasted HTML tables to Markdown pipe tables', () => {
    assert.equal(
      htmlBlockToMarkdown([
        '<table>',
        '<thead><tr><th style="text-align:left">Feature</th><th>Notes</th></tr></thead>',
        '<tbody><tr><td>Tables</td><td>Cells with | pipes</td></tr></tbody>',
        '</table>'
      ].join('')),
      [
        '| Feature | Notes               |',
        '| :---    | ---                 |',
        '| Tables  | Cells with \\| pipes |'
      ].join('\n')
    );
  });

  it('normalizes list marker spacing and preserves task checkboxes', () => {
    assert.equal(
      htmlBlockToMarkdown('<ul><li><input type="checkbox" checked> Done</li><li>Next</li></ul>'),
      ['- [x] Done', '- Next'].join('\n')
    );
    assert.equal(
      htmlBlockToMarkdown('<ol><li>First</li><li>Second</li></ol>'),
      ['1. First', '2. Second'].join('\n')
    );
  });

  it('preserves ordered list numbering when the block editor submits one list item', () => {
    assert.equal(
      htmlBlockToMarkdown('<li>Second numbered item edited</li>', {
        sourceMarkdown: ['1. First numbered item', '2. Second numbered item', '3. Third numbered item'].join('\n'),
        oneBasedLineStart: 2
      }),
      '2. Second numbered item edited'
    );
  });

  it('preserves custom ordered markers and nested list content on edited list items', () => {
    assert.equal(
      htmlBlockToMarkdown('<li>Current item edited<ul><li>Nested detail</li></ul></li>', {
        sourceMarkdown: ['9) Previous', '10) Current item'].join('\n'),
        oneBasedLineStart: 2
      }),
      ['10) Current item edited', '    - Nested detail'].join('\n')
    );
  });

  it('keeps nested list item indentation relative to the original source indent', () => {
    assert.equal(
      htmlBlockToMarkdown('<li>Current item edited<ul><li>Nested detail</li></ul></li>', {
        sourceMarkdown: ['1. Parent', '  1. Current item'].join('\n'),
        oneBasedLineStart: 2
      }),
      ['  1. Current item edited', '      - Nested detail'].join('\n')
    );
  });

  it('leaves intentional non-list block replacements alone', () => {
    assert.equal(
      htmlBlockToMarkdown('<h2>Current item</h2>', {
        sourceMarkdown: '2. Current item',
        oneBasedLineStart: 1
      }),
      '## Current item'
    );
  });

  it('lets the HTML parser repair badly nested emphasis before Markdown conversion', () => {
    assert.equal(htmlBlockToMarkdown('<p><b><i>Important</b></i></p>'), '***Important***');
  });
});
