export type ReviewStatus = 'open' | 'accepted' | 'rejected' | 'resolved';
export type ReviewSource = 'human' | 'ai' | 'local';
export type ReviewActor = 'user' | 'assistant';
export type ReviewType = 'fix' | 'question' | 'note' | 'risk' | 'suggestion';
export type ReviewSeverity = 'low' | 'medium' | 'high';
export type AnchorConfidence = 'exact' | 'recovered' | 'approximate' | 'missing' | 'ambiguous';

export interface ReviewAnchor {
  text: string;
  lineStart?: number;
  lineEnd?: number;
  hash?: string;
  occurrence?: number;
  contextBefore?: string;
  contextAfter?: string;
  confidence?: AnchorConfidence;
  lastLocatedLine?: number;
  lastLocatedAt?: string;
}

export interface SuggestedPatch {
  mode: 'replace';
  original: string;
  replacement: string;
}

export interface ReviewReply {
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
}

export interface ReviewThread {
  id: string;
  documentUri: string;
  anchor: ReviewAnchor;
  type: ReviewType;
  source: ReviewSource;
  status: ReviewStatus;
  closedBy?: ReviewActor;
  closedAt?: string;
  severity: ReviewSeverity;
  comment: string;
  suggestedPatch?: SuggestedPatch;
  thread: ReviewReply[];
  createdAt: string;
  updatedAt: string;
}

export interface ReviewDocument {
  documentUri: string;
  threads: ReviewThread[];
  updatedAt: string;
}
