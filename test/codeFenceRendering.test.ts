import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderReviewableCodeFence } from '../src/codeFenceRendering';

describe('renderReviewableCodeFence', () => {
  it('adds source line range metadata to fenced code blocks', () => {
    const html = renderReviewableCodeFence(
      'const alpha = 1;\nconst beta = 2;\n',
      'ts',
      4,
      8
    );

    assert.match(html, /<pre class="review-code-fence" data-review-code-fence data-source-line="5" data-source-line-end="8">/);
    assert.match(html, /<code class="language-ts">const alpha = 1;\nconst beta = 2;\n<\/code>/);
  });

  it('escapes source without collapsing multiline code text', () => {
    const html = renderReviewableCodeFence('if (a < b) {\n  return a && b;\n}\n');

    assert.match(html, /if \(a &lt; b\) \{\n  return a &amp;&amp; b;\n\}\n/);
  });
});
