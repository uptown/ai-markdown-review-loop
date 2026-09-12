import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createReviewClipboard } from '../src/reviewClipboard';
import { REVIEW_TASK_GUIDANCE, parseReviewTaskSidecar } from '../src/reviewTaskProtocol';

const contents = JSON.stringify({ schemaVersion: 3, document: 'spec.md', guidance: REVIEW_TASK_GUIDANCE,
  items: [{ id: 'rv_scope', rev: 2, comment: 'Clarify scope.', target: { quote: 'Scope', line: 1 } }] }, null, 2);

describe('portable copied review context', () => {
  it('distinguishes same-basename documents without exposing local absolute paths', () => {
    const folders = [{ name: 'Project', fsPath: '/private/project' }];
    const first = createReviewClipboard(contents, '/private/project/product/spec.md', folders);
    const second = createReviewClipboard(contents, '/private/project/engineering/spec.md', folders);
    assert.notEqual(first, second);
    assert.deepEqual(JSON.parse(first).context, { workspaceFolder: 'Project', path: 'product/spec.md' });
    assert.doesNotMatch(first, /private|\n/);
    assert.deepEqual(parseReviewTaskSidecar(JSON.parse(first)).items, JSON.parse(contents).items);
  });

  it('distinguishes roots and uses the most specific containing folder', () => {
    const folders = [{ name: 'Outer', fsPath: '/project' }, { name: 'Docs', fsPath: '/project/docs' }];
    assert.deepEqual(JSON.parse(createReviewClipboard(contents, '/project/docs/spec.md', folders)).context,
      { workspaceFolder: 'Docs', path: 'spec.md' });
  });

  it('reports unresolved context instead of guessing an outside or duplicate-name folder', () => {
    assert.throws(() => createReviewClipboard(contents, '/outside/spec.md', [{ name: 'Project', fsPath: '/project' }]), /Open the Markdown folder/);
    assert.throws(() => createReviewClipboard(contents, '/project-other/spec.md', [{ name: 'Project', fsPath: '/project' }]), /Open the Markdown folder/);
    assert.throws(() => createReviewClipboard(contents, '/one/spec.md', [
      { name: 'Docs', fsPath: '/one' }, { name: 'Docs', fsPath: '/two' }
    ]), /unique name/);
  });

  it('keeps Windows and Unicode paths portable', () => {
    const copied = JSON.parse(createReviewClipboard(contents, 'C:\\Users\\someone\\docs\\design notes\\spec.md',
      [{ name: 'Docs', fsPath: 'C:\\Users\\someone\\docs' }]));
    assert.deepEqual(copied.context, { workspaceFolder: 'Docs', path: 'design notes/spec.md' });
    const unicode = JSON.parse(createReviewClipboard(contents, '/workspace/문서/spec.md', [{ name: 'Project', fsPath: '/workspace' }]));
    assert.equal(unicode.context.path, '문서/spec.md');
  });
});
