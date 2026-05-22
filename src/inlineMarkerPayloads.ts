import type { ReviewThread } from './types';

export interface InlineAnchorMarker {
  id: string;
  status?: string;
  hash?: string;
  sidecar?: string;
  lineStart?: number;
  lineEnd?: number;
}

export interface InlineReviewLogMarker {
  id: string;
  status: string;
  sidecar: string;
  updatedAt: string;
}

export function createInlineAnchorBlockPattern(): RegExp {
  return /^<!-- ai-review-anchors?:.*?-->\r?\n?/gm;
}

export function stripInlineAnchorMarkers(markdown: string): string {
  return markdown.replace(/[ \t]*<!-- ai-review-(?:anchors?|log):.*?-->\r?\n?/g, '');
}

export function removeInlineReviewLogMarkers(
  markdown: string,
  threadIds: Iterable<string>
): string {
  const ids = new Set(threadIds);

  if (ids.size === 0) {
    return markdown;
  }

  return markdown.replace(/[ \t]*<!-- ai-review-log:(.*?)-->\r?\n?/g, (match, payload) => {
    const id = readReviewLogId(payload);
    return id && ids.has(id) ? '' : match;
  });
}

export function readInlineAnchorMarkers(markdown: string): InlineAnchorMarker[] {
  const markers: InlineAnchorMarker[] = [];
  const singleAnchorPattern = /^<!-- ai-review-anchor:(.*?)-->/gm;
  const anchorGroupPattern = /^<!-- ai-review-anchors:(.*?)-->/gm;
  let match: RegExpExecArray | null;

  while ((match = singleAnchorPattern.exec(markdown)) !== null) {
    markers.push(...parseInlineAnchorPayload(match[1]));
  }

  while ((match = anchorGroupPattern.exec(markdown)) !== null) {
    markers.push(...parseInlineAnchorPayload(match[1]));
  }

  return markers;
}

export function findStaleInlineAnchorMarkers(
  markdown: string,
  threads: ReviewThread[]
): InlineAnchorMarker[] {
  const threadsById = new Map(threads.map(thread => [thread.id, thread]));

  return readInlineAnchorMarkers(markdown).filter(marker => {
    const thread = threadsById.get(marker.id);
    return !thread || thread.status !== 'open';
  });
}

export function createInlineAnchorMarker(payloads: InlineAnchorMarker[]): string {
  const sidecar = payloads[0]?.sidecar;

  if (sidecar && payloads.every(payload => payload.sidecar === sidecar)) {
    return `<!-- ai-review-anchors:${JSON.stringify({
      sidecar,
      ids: payloads.map(payload => payload.id)
    })} -->`;
  }

  return `<!-- ai-review-anchors:${JSON.stringify(payloads.map(compactMarker))} -->`;
}

export function createInlineReviewLogMarker(payload: InlineReviewLogMarker): string {
  return `<!-- ai-review-log:${JSON.stringify(payload)} -->`;
}

export function dedupeInlineAnchorMarkers(markers: InlineAnchorMarker[]): InlineAnchorMarker[] {
  const seen = new Set<string>();
  const deduped: InlineAnchorMarker[] = [];

  for (const marker of markers) {
    if (seen.has(marker.id)) {
      continue;
    }

    seen.add(marker.id);
    deduped.push(marker);
  }

  return deduped;
}

export function removeInlineAnchorMarkerPayloads(
  markers: InlineAnchorMarker[],
  threadIds: Iterable<string>
): InlineAnchorMarker[] {
  const ids = new Set(threadIds);
  return dedupeInlineAnchorMarkers(markers.filter(marker => !ids.has(marker.id)));
}

export function replaceInlineAnchorMarkersInMarkdown(
  markdown: string,
  markers: InlineAnchorMarker[]
): string {
  const withoutAnchors = markdown.replace(createInlineAnchorBlockPattern(), '');
  const deduped = dedupeInlineAnchorMarkers(markers);

  if (deduped.length === 0) {
    return withoutAnchors;
  }

  return appendMetadataLine(withoutAnchors, createInlineAnchorMarker(deduped));
}

export function upsertInlineAnchorMarkersInMarkdown(
  markdown: string,
  markers: InlineAnchorMarker[]
): string {
  return replaceInlineAnchorMarkersInMarkdown(
    markdown,
    [
      ...readInlineAnchorMarkers(markdown),
      ...markers
    ]
  );
}

export function removeInlineAnchorMarkersFromMarkdown(
  markdown: string,
  threadIds: Iterable<string>
): string {
  return replaceInlineAnchorMarkersInMarkdown(
    markdown,
    removeInlineAnchorMarkerPayloads(readInlineAnchorMarkers(markdown), threadIds)
  );
}

export function appendInlineReviewLogMarker(
  markdown: string,
  payload: InlineReviewLogMarker
): string {
  if (markdown.includes(`ai-review-log:{"id":"${payload.id}"`)
    || markdown.includes(`ai-review-log:{"id": "${payload.id}"`)) {
    return markdown;
  }

  return appendMetadataLine(markdown, createInlineReviewLogMarker(payload));
}

function parseInlineAnchorPayload(payload: string): InlineAnchorMarker[] {
  try {
    const parsed = JSON.parse(payload.trim());

    if (Array.isArray(parsed)) {
      return parsed.filter(isInlineAnchorMarker);
    }

    if (isCompactInlineAnchorGroup(parsed)) {
      return parsed.ids.map(id => ({ id, sidecar: parsed.sidecar }));
    }

    return isInlineAnchorMarker(parsed) ? [parsed] : [];
  } catch {
    // Ignore malformed anchors here; invalid sidecar JSON is handled separately.
    return [];
  }
}

function readReviewLogId(payload: string): string | undefined {
  try {
    const parsed = JSON.parse(payload.trim());
    return isRecord(parsed) && typeof parsed.id === 'string' ? parsed.id : undefined;
  } catch {
    return undefined;
  }
}

function compactMarker(marker: InlineAnchorMarker): InlineAnchorMarker {
  return {
    id: marker.id,
    sidecar: marker.sidecar
  };
}

function appendMetadataLine(markdown: string, marker: string): string {
  const prefix = markdown.length > 0 && !markdown.endsWith('\n') ? '\n' : '';
  return `${markdown}${prefix}${marker}\n`;
}

function isInlineAnchorMarker(value: unknown): value is InlineAnchorMarker {
  if (!isRecord(value) || typeof value.id !== 'string') {
    return false;
  }

  return optionalString(value.status)
    && optionalString(value.hash)
    && optionalString(value.sidecar)
    && optionalNumber(value.lineStart)
    && optionalNumber(value.lineEnd);
}

function isCompactInlineAnchorGroup(value: unknown): value is { sidecar: string; ids: string[] } {
  return isRecord(value)
    && typeof value.sidecar === 'string'
    && Array.isArray(value.ids)
    && value.ids.every(id => typeof id === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function optionalNumber(value: unknown): boolean {
  return value === undefined || typeof value === 'number';
}
