import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findNormalizedTextSpan } from '../src/normalizedText';

describe('code selection raw spans (R10)', () => {
  for (const [raw, needle, expected] of [
    ['  const myResult = 1;\n', 'Result', 'Result'],
    ['\t\tResult = 1;\n', 'Result', 'Result'],
    ['\n\tconst first = 1;\n  const second = 2;\n', '1; const second', '1;\n  const second'],
    ['  한글Result끝', 'Result', 'Result'],
    ['  🐈Result', 'Result', 'Result']
  ]) {
    it('keeps the exact selected source span in ' + JSON.stringify(raw), () => {
      const normalized = raw.replace(/\s+/g, ' ').trim();
      const match = findNormalizedTextSpan(raw, needle, normalized.indexOf(needle));
      assert.ok(match);
      assert.equal(raw.slice(match.start, match.start + match.length), expected);
    });
  }
  it('maps the requested duplicate occurrence and rejects invalid indices', () => {
    const raw = '  Result\n\tResult';
    assert.deepEqual(findNormalizedTextSpan(raw, 'Result', 7), { start: 10, length: 6 });
    assert.equal(findNormalizedTextSpan(raw, 'Result', 2), undefined);
    assert.equal(findNormalizedTextSpan(raw, '', 0), undefined);
  });
});
