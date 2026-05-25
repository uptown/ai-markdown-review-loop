import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { selectAnchorMatch } from '../src/anchorMatching';

describe('anchor matching', () => {
  it('keeps a repeated word on the selected line inside a multiline rendered block', () => {
    const markdown = [
      'Outside word',
      'A rendered block starts with word',
      'The selected word is here',
      'A lower word must not win'
    ].join('\n');

    const match = selectAnchorMatch(markdown, 'word', {
      occurrence: 2,
      lineStartHint: 2,
      lineEndHint: 3
    });

    assert.equal(lineNumberAt(markdown, match), 3);
  });

  it('prefers the hinted line when rendered occurrence was shifted by hidden source text', () => {
    const markdown = [
      'hidden front matter word',
      'target word',
      'lower word'
    ].join('\n');

    const match = selectAnchorMatch(markdown, 'word', {
      occurrence: 2,
      lineStartHint: 2,
      lineEndHint: 2
    });

    assert.equal(lineNumberAt(markdown, match), 2);
  });

  it('uses local occurrence inside the hinted line range', () => {
    const markdown = [
      'prior word',
      'first word then second word'
    ].join('\n');

    const first = selectAnchorMatch(markdown, 'word', {
      occurrence: 1,
      lineStartHint: 2,
      lineEndHint: 2
    });
    const second = selectAnchorMatch(markdown, 'word', {
      occurrence: 2,
      lineStartHint: 2,
      lineEndHint: 2
    });

    assert.equal(offsetSnippet(markdown, first), 'word then second');
    assert.equal(offsetSnippet(markdown, second), 'word');
    assert.ok((second?.index ?? 0) > (first?.index ?? 0));
  });

  it('does not jump to a lower repeated word when the hinted range has a match', () => {
    const markdown = [
      'word in paragraph one',
      '',
      'word in paragraph two',
      '',
      'word in paragraph three'
    ].join('\n');

    const match = selectAnchorMatch(markdown, 'word', {
      occurrence: 2,
      lineStartHint: 1,
      lineEndHint: 1
    });

    assert.equal(lineNumberAt(markdown, match), 1);
  });
});

function lineNumberAt(text: string, match: { index: number } | undefined): number {
  assert.ok(match, 'expected a match');
  return text.slice(0, match.index).split('\n').length;
}

function offsetSnippet(text: string, match: { index: number } | undefined): string {
  assert.ok(match, 'expected a match');
  return text.slice(match.index, match.index + 16).trim();
}
