import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type * as Vscode from 'vscode';
import { createLocalReviewThreads } from '../src/localReview';

function document(text: string): Vscode.TextDocument {
  const lines = text.split(/\r?\n/);
  return {
    uri: { toString: () => 'file:///workspace/spec.md' }, fileName: '/workspace/spec.md',
    getText: () => text, lineCount: lines.length, lineAt: (line: number) => ({ text: lines[line] })
  } as unknown as Vscode.TextDocument;
}

describe('local review document structure', () => {
  it('recognizes English and Korean acceptance headings including formatting and setext syntax', () => {
    for (const heading of ['## Acceptance Criteria', '## Acceptance', '## 완료 기준', '## 검증 기준', '#### **완료 기준**', '검증 기준\n---------', '## Acceptance Criteria: release']) {
      assert.deepEqual(createLocalReviewThreads(document(`# Spec\n\n${heading}\n\n- The checks pass.`)), [], heading);
    }
  });

  it('does not confuse heading prefixes with actual acceptance headings', () => {
    for (const heading of ['## AcceptanceCriteria', '## 완료 기준서', '## 검증 기준값']) {
      assert.equal(createLocalReviewThreads(document(`# Spec\n\n${heading}`)).filter(thread => thread.type === 'fix').length, 1, heading);
    }
  });

  it('ignores fenced and indented code for headings, placeholders, and long-line checks', () => {
    const text = ['# Spec', '', '```markdown', '## Acceptance Criteria', `TODO: ${'x'.repeat(240)}`, '```', '', '    FIXME in a code example'].join('\n');
    const threads = createLocalReviewThreads(document(text));
    assert.equal(threads.length, 1);
    assert.equal(threads[0].type, 'fix');
    assert.equal(threads[0].anchor.text, '# Spec');
  });

  it('ignores inline code examples and anchors a missing-heading finding outside repeated code text', () => {
    const examples = ['# Spec', '', '## Acceptance Criteria', '', `Use \`TODO ${'x'.repeat(240)}\` as an example.`].join('\n');
    assert.deepEqual(createLocalReviewThreads(document(examples)), []);
    const repeated = ['```markdown', '# Spec', '```', '', '# Spec'].join('\n');
    const threads = createLocalReviewThreads(document(repeated));
    assert.equal(threads.length, 1);
    assert.equal(threads[0].anchor.lineStart, 5);
  });

  it('still flags real placeholders and long prose beside code examples', () => {
    const text = ['# Spec', '', '## 완료 기준', '', 'TODO: choose a retry limit.', '', `A long prose line ${'word '.repeat(50)}`, '', '~~~text', 'FIXME: example only', '~~~'].join('\n');
    const threads = createLocalReviewThreads(document(text));
    assert.deepEqual(threads.map(thread => thread.type), ['question', 'suggestion']);
    assert.equal(threads[0].anchor.lineStart, 5);
    assert.equal(threads[1].anchor.lineStart, 7);
  });
});
