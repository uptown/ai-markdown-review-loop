import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMarkdownImageAnchorText,
  isRemoteMarkdownImageSource,
  markdownImageReviewLabel
} from '../src/markdownImageAnchors';

describe('Markdown image anchors', () => {
  it('creates a stable Markdown image anchor for review threads', () => {
    assert.equal(
      createMarkdownImageAnchorText({
        alt: 'Launch diagram',
        src: './assets/launch.png',
        title: 'Draft'
      }),
      '![Launch diagram](./assets/launch.png "Draft")'
    );
  });

  it('falls back to source path labels when alt text is missing', () => {
    assert.equal(
      markdownImageReviewLabel({
        alt: '',
        src: './assets/launch.png'
      }),
      './assets/launch.png'
    );
  });

  it('detects remote image URLs so the preview can avoid silent network loads', () => {
    assert.equal(isRemoteMarkdownImageSource('https://example.com/image.png'), true);
    assert.equal(isRemoteMarkdownImageSource('http://example.com/image.png'), true);
    assert.equal(isRemoteMarkdownImageSource('./assets/image.png'), false);
  });
});
