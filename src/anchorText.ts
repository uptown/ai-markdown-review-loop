import { createHash } from 'crypto';

export function normalizeAnchorText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function hashAnchor(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}
