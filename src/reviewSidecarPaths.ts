export const REVIEW_SIDECAR_EXTENSION = '.ai-review.json';
export const LEGACY_REVIEW_STORAGE_ROOT = '.ai-markdown-review';
export const LEGACY_OPEN_REVIEW_FOLDER = 'documents';
export const LEGACY_CLOSED_REVIEW_FOLDER = 'resolved';

export function createColocatedReviewSidecarFileName(markdownFileName: string): string {
  return `.${markdownFileName}${REVIEW_SIDECAR_EXTENSION}`;
}

export function isColocatedReviewSidecarFileName(fileName: string): boolean {
  return fileName.startsWith('.') && fileName.endsWith(REVIEW_SIDECAR_EXTENSION);
}
