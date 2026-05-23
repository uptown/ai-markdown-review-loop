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

export function rebaseInlineReviewMetadataSidecars(
  markdown: string,
  sidecarRewrites: Record<string, string>
): string {
  if (Object.keys(sidecarRewrites).length === 0) {
    return markdown;
  }

  return rewriteOutsideFencedCode(markdown, line => {
    return line.replace(/([ \t]*)<!-- ai-review-(anchor|anchors|log):(.*?)-->/g, (match, leading, kind, payload) => {
      const rewritten = rewriteInlineMetadataPayload(kind, payload, sidecarRewrites);
      return rewritten ? `${leading}<!-- ai-review-${kind}:${rewritten} -->` : match;
    });
  });
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

function rewriteInlineMetadataPayload(
  kind: string,
  payload: string,
  sidecarRewrites: Record<string, string>
): string | undefined {
  try {
    const parsed = JSON.parse(payload.trim());

    if (kind === 'log' && isInlineReviewLogMarker(parsed)) {
      return JSON.stringify({
        ...parsed,
        sidecar: sidecarRewrites[parsed.sidecar] ?? parsed.sidecar
      });
    }

    if (kind === 'anchor' || kind === 'anchors') {
      if (Array.isArray(parsed)) {
        return JSON.stringify(parsed.map(marker => {
          if (!isInlineAnchorMarker(marker)) {
            return marker;
          }

          return {
            ...marker,
            sidecar: marker.sidecar ? (sidecarRewrites[marker.sidecar] ?? marker.sidecar) : marker.sidecar
          };
        }));
      }

      if (isCompactInlineAnchorGroup(parsed)) {
        return JSON.stringify({
          ...parsed,
          sidecar: sidecarRewrites[parsed.sidecar] ?? parsed.sidecar
        });
      }

      if (isInlineAnchorMarker(parsed)) {
        return JSON.stringify({
          ...parsed,
          sidecar: parsed.sidecar ? (sidecarRewrites[parsed.sidecar] ?? parsed.sidecar) : parsed.sidecar
        });
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function rewriteOutsideFencedCode(
  markdown: string,
  rewriteLine: (line: string) => string
): string {
  const parts = markdown.split(/(\r?\n)/);
  const rewritten: string[] = [];
  let fence: { marker: string; length: number } | undefined;

  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index] ?? '';
    const newline = parts[index + 1] ?? '';
    const fenceMatch = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/);

    if (!fence && fenceMatch) {
      fence = {
        marker: fenceMatch[1][0],
        length: fenceMatch[1].length
      };
      rewritten.push(line, newline);
      continue;
    }

    if (fence) {
      rewritten.push(line, newline);

      if (fenceMatch
        && fenceMatch[1][0] === fence.marker
        && fenceMatch[1].length >= fence.length) {
        fence = undefined;
      }

      continue;
    }

    rewritten.push(rewriteLine(line), newline);
  }

  return rewritten.join('');
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

function isInlineReviewLogMarker(value: unknown): value is InlineReviewLogMarker {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.status === 'string'
    && typeof value.sidecar === 'string'
    && typeof value.updatedAt === 'string';
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
