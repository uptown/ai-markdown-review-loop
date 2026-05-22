import type { ReviewThread } from './types';

export interface InlineAnchorMarker {
  id: string;
  status?: string;
  hash?: string;
  sidecar?: string;
  lineStart?: number;
  lineEnd?: number;
}

export function createInlineAnchorBlockPattern(): RegExp {
  return /^<!-- ai-review-anchors?:.*?-->\r?\n?/gm;
}

export function stripInlineAnchorMarkers(markdown: string): string {
  return markdown.replace(/[ \t]*<!-- ai-review-(?:anchors?|log):.*?-->\r?\n?/g, '');
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

function compactMarker(marker: InlineAnchorMarker): InlineAnchorMarker {
  return {
    id: marker.id,
    sidecar: marker.sidecar
  };
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
