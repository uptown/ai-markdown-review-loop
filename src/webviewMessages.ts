import type { ReviewThread } from './types';
import type { MarkdownTableBlock, MarkdownTableData, MarkdownTableSourceMapping } from './tableEdits';

export interface PreviewRestoreState {
  focusThreadId?: string;
  overlayThreadIds?: string[];
  mutationResults?: Record<string, { ok: boolean; error?: string }>;
}

export interface ReviewWebviewState {
  previewId: string;
  threads: ReviewThread[];
  tables: MarkdownTableBlock[];
  canEditMarkdown: boolean;
  trusted: boolean;
  reviewFileState: string;
  sourceLines: string[];
  sourceLineEnding: string;
  documentVersion: number;
  documentUri: string;
  sourceFingerprint: string;
  restoreState: PreviewRestoreState;
}

type SourceRange = { lineStart: number; lineEnd: number };
type BlockContent = { html?: string; rawMarkdown?: string };
export type WebviewToHostMessage = (
  | { type: 'webviewReady'; previewId: string }
  | { type: 'addComment'; anchorText: string; anchorOccurrence?: number; sourceLine?: number; sourceLineEnd?: number; comment: string }
  | { type: 'editComment'; threadId: string; taskRevision?: number; comment: string }
  | { type: 'removeComment'; threadId: string; taskRevision?: number }
  | ({ type: 'editMarkdownBlock'; intent?: string } & SourceRange & BlockContent)
  | ({ type: 'insertMarkdownBlock'; afterLine: number } & BlockContent)
  | ({ type: 'deleteMarkdownBlock' } & SourceRange)
  | ({ type: 'editMermaidSource'; source: string } & SourceRange)
  | ({ type: 'editMarkdownTable'; tableSourceMapping: MarkdownTableSourceMapping } & SourceRange & MarkdownTableData)
  | { type: 'convertMarkdownBlockHtml'; lineStart: number; html: string }
  | { type: 'copyDraft'; text?: string; html?: string; sourceMarkdown?: string; table?: MarkdownTableData }
  | { type: 'copyText'; text: string }
  | { type: 'copyReviewJson' | 'cleanupLegacyMetadata' | 'refreshPreview' }
) & { requestId?: string; documentVersion?: number };

export type HostToWebviewMessage =
  | { type: 'reviewMutationResult'; requestId: string; ok: boolean; error?: string }
  | { type: 'reviewRefreshFailed'; error: string }
  | { type: 'convertedMarkdownBlockHtml'; requestId?: string; rawMarkdown?: string; error?: string }
  | { type: 'reviewStateUpdated'; state: ReviewWebviewState };

/** Guard the host/browser boundary before browser listeners narrow the union. */
export function readHostMessage(value: unknown): HostToWebviewMessage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const message = value as Record<string, unknown>;
  const optionalText = (field: unknown) => field === undefined || typeof field === 'string';
  switch (message.type) {
    case 'reviewMutationResult':
      if (typeof message.requestId === 'string' && typeof message.ok === 'boolean' && optionalText(message.error))
        return message as Extract<HostToWebviewMessage, { type: 'reviewMutationResult' }>;
      break;
    case 'reviewRefreshFailed':
      if (typeof message.error === 'string') return { type: 'reviewRefreshFailed', error: message.error };
      break;
    case 'convertedMarkdownBlockHtml':
      if (typeof message.requestId === 'string' && optionalText(message.rawMarkdown) && optionalText(message.error)
        && (typeof message.rawMarkdown === 'string' || typeof message.error === 'string'))
        return message as Extract<HostToWebviewMessage, { type: 'convertedMarkdownBlockHtml' }>;
      break;
    case 'reviewStateUpdated': {
      const state = message.state as ReviewWebviewState | undefined;
      if (state && typeof state.previewId === 'string' && typeof state.documentUri === 'string' && Number.isInteger(state.documentVersion)
        && typeof state.sourceFingerprint === 'string' && Array.isArray(state.threads) && Array.isArray(state.sourceLines))
        return { type: 'reviewStateUpdated', state };
      break;
    }
  }
  return undefined;
}

export const webviewMessageTypes: ReadonlySet<WebviewToHostMessage['type']> = new Set([
  'addComment', 'editComment', 'removeComment', 'editMarkdownBlock', 'insertMarkdownBlock',
  'deleteMarkdownBlock', 'editMermaidSource', 'editMarkdownTable', 'convertMarkdownBlockHtml',
  'copyDraft', 'copyText', 'copyReviewJson', 'cleanupLegacyMetadata', 'refreshPreview', 'webviewReady'
]);
