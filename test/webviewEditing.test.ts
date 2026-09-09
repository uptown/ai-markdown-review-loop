import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { htmlBlockToMarkdown } from '../src/htmlToMarkdown';
import { createProviderHarness, runWebview } from './helpers/providerHarness';

describe('rendered edit event paths', () => {
  it('keeps quote and list children inside their source-owning parent editor (R09)', async () => {
    const source = '> Quoted text.\n\n- First paragraph.\n\n  Second paragraph.';
    const h = await createProviderHarness(source);
    const dom = runWebview(h.render());
    assert.equal(dom.document.querySelectorAll('blockquote > .block-edit-actions').length, 1);
    assert.equal(dom.document.querySelectorAll('blockquote p .block-edit-actions').length, 0);
    assert.equal(dom.document.querySelectorAll('li p .block-edit-actions').length, 0);
    dom.dispatch(dom.document.querySelector('blockquote > .block-edit-actions [data-edit-markdown-block]'), 'click');
    const editor = dom.document.getElementById('block-editor-surface');
    editor.querySelector('p').textContent = 'Revised text.';
    dom.dispatch(dom.document.getElementById('block-editor'), 'submit');
    const message = dom.messages.find((value: any) => value.type === 'editMarkdownBlock');
    assert.ok(message);
    assert.equal(message.documentVersion, 1);
    assert.equal(htmlBlockToMarkdown(message.html, { sourceMarkdown: source, oneBasedLineStart: 1 }), '> Revised text.');
  });

  it('saves actual rendered image paragraphs with original syntax and no preview controls (R05)', async () => {
    for (const image of ['![Diagram](./diagram.png "Title")', '![Diagram](https://example.com/diagram.png)']) {
      const source = 'Read ' + image + ' carefully.';
      const h = await createProviderHarness(source);
      const dom = runWebview(h.render());
      dom.dispatch(dom.document.querySelector('[data-edit-markdown-block]'), 'click');
      dom.dispatch(dom.document.getElementById('block-editor'), 'submit');
      const message = dom.messages.find((value: any) => value.type === 'editMarkdownBlock');
      assert.ok(message);
      assert.equal(htmlBlockToMarkdown(message.html, { sourceMarkdown: source, oneBasedLineStart: 1 }), source);
    }
  });

  it('retains original row and column identities through actual table controls (R06)', async () => {
    const h = await createProviderHarness('| Feature | Status |\n| --- | --- |\n| Tables | Gap |\n| Mermaid | Open |');
    const dom = runWebview(h.render());
    dom.dispatch(dom.document.querySelector('[data-edit-markdown-table]'), 'click');
    dom.dispatch(dom.document.querySelector('[data-remove-table-row][data-row="0"]'), 'click');
    dom.dispatch(dom.document.querySelector('[data-remove-table-column][data-column="0"]'), 'click');
    dom.dispatch(dom.document.getElementById('table-editor-add-row'), 'click');
    dom.dispatch(dom.document.getElementById('table-editor-add-column'), 'click');
    dom.dispatch(dom.document.getElementById('table-editor'), 'submit');
    const message = dom.messages.find((value: any) => value.type === 'editMarkdownTable');
    assert.ok(message);
    assert.deepEqual(JSON.parse(JSON.stringify(message.tableSourceMapping)), { rowSources: [1, null], columnSources: [1, null] });
    assert.equal(message.rows[0][0], 'Open');
    assert.equal(message.documentVersion, 1);
  });

  it('highlights precisely the selected identifier inside an indented code fence (R10)', async () => {
    const h = await createProviderHarness('```ts\n  const myResult = 1;\n```');
    const dom = runWebview(h.render());
    dom.evaluate(`highlightTextNode({id:'rv_code', source:'human', anchor:{text:'Result', lineStart:2}}, 'Result')`);
    const marker = dom.document.querySelector('.review-anchor');
    assert.ok(marker);
    // Badges are UI and are not part of the original selected text.
    Array.from(marker.querySelectorAll('button')).forEach((element: any) => element.remove());
    assert.equal(marker.textContent, 'Result');
    assert.equal(dom.messages.find((value: any) => value.type === 'anchorLocated').documentVersion, 1);
  });

  it('edits a quoted table through its owning raw block without dropping the quote (R09)', async () => {
    const source = '> | A | B |\n> | --- | --- |\n> | one | two |';
    const h = await createProviderHarness(source);
    const dom = runWebview(h.render());
    assert.equal(dom.document.querySelectorAll('[data-edit-markdown-table]').length, 0);
    dom.dispatch(dom.document.querySelector('blockquote > .block-edit-actions [data-edit-markdown-block]'), 'click');
    assert.equal(dom.document.getElementById('block-editor-raw').value, source);
    assert.equal(dom.document.getElementById('block-editor-raw').classList.contains('is-visible'), true);
    dom.dispatch(dom.document.getElementById('block-editor'), 'submit');
    const message = dom.messages.find((value: any) => value.type === 'editMarkdownBlock');
    assert.equal(message.rawMarkdown, source);
  });
});
