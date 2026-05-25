export interface MarkdownImageAnchorInput {
  alt?: string;
  src: string;
  title?: string;
}

export function createMarkdownImageAnchorText(input: MarkdownImageAnchorInput): string {
  const alt = String(input.alt ?? '').replace(/\]/g, '\\]');
  const src = String(input.src ?? '').trim();
  const title = String(input.title ?? '').trim();

  if (title) {
    return `![${alt}](${src} "${title.replace(/"/g, '\\"')}")`;
  }

  return `![${alt}](${src})`;
}

export function markdownImageReviewLabel(input: MarkdownImageAnchorInput): string {
  const alt = String(input.alt ?? '').trim();

  if (alt) {
    return alt;
  }

  return String(input.src ?? '').trim() || 'Image';
}

export function isRemoteMarkdownImageSource(src: string): boolean {
  return /^https?:\/\//i.test(src.trim());
}
