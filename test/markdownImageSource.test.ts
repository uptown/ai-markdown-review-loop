import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import MarkdownIt from 'markdown-it';
import { applyMarkdownImageSourceMapping } from '../src/markdownImageSource';
import { htmlBlockToMarkdown } from '../src/htmlToMarkdown';

describe('Markdown image source preservation', () => {
  it('captures each image source without reconstructing escaping, titles, or references', () => {
    const markdown = new MarkdownIt();
    applyMarkdownImageSourceMapping(markdown);
    const originals = [
      '![Diagram](./diagram.png "Original  title")',
      '![A \\] bracket](<./diagram with spaces.png> \'Single quoted title\')',
      '![Ref][source-image]',
      '![source-image][]',
      '![source-image]'
    ];
    const source = originals.join(' and ') + '\n\n[source-image]: ./ref.png "Reference title"';
    const images = markdown.parse(source, {}).flatMap(token => token.children || []).filter(token => token.type === 'image');

    assert.deepEqual(images.map(token => token.meta.reviewSourceMarkdown), originals);
    assert.equal(images[1].attrGet('src'), './diagram%20with%20spaces.png');
    assert.equal(images[2].attrGet('title'), 'Reference title');
  });

  it('round-trips source-mapped image syntax while editing surrounding prose', () => {
    const markdown = new MarkdownIt();
    applyMarkdownImageSourceMapping(markdown);
    markdown.renderer.rules.image = (tokens, index) => {
      const source = markdown.utils.escapeHtml(tokens[index].meta.reviewSourceMarkdown);
      return `<span data-markdown-image data-image-markdown="${source}"><img src="https://file+.vscode-resource.vscode-cdn.net/image.png"><button>Feedback</button></span>`;
    };
    const original = '![A \\] bracket](<./diagram with spaces.png> \'Original  title\')';
    const rendered = markdown.render(`Read ${original} carefully.`);
    assert.equal(htmlBlockToMarkdown(rendered.replace('Read ', 'Updated ')), `Updated ${original} carefully.`);
  });
});
