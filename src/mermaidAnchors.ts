import { normalizeAnchorText } from './anchorText';
import type { ReviewThread } from './types';

export type MermaidAnchorMatchState = 'exact' | 'approximate' | 'none';

export interface MermaidSourceBlock {
  source: string;
  lineStart?: number;
  lineEnd?: number;
}

export interface MermaidThreadMatch {
  threadId: string;
  state: Exclude<MermaidAnchorMatchState, 'none'>;
}

export function collectMermaidSourceBlocks(markdown: string): MermaidSourceBlock[] {
  const lines = markdown.split(/\r\n|\r|\n/);
  const blocks: MermaidSourceBlock[] = [];
  let fence: {
    marker: string;
    lineStart: number;
    sourceLines: string[];
  } | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (!fence) {
      const opening = line.match(/^(\s*)(`{3,}|~{3,})\s*mermaid(?:\s|$)/i);

      if (opening) {
        fence = {
          marker: opening[2],
          lineStart: index + 1,
          sourceLines: []
        };
      }

      continue;
    }

    if (isClosingFence(line, fence.marker)) {
      blocks.push({
        source: fence.sourceLines.join('\n'),
        lineStart: fence.lineStart,
        lineEnd: index + 1
      });
      fence = undefined;
      continue;
    }

    fence.sourceLines.push(line);
  }

  return blocks;
}

export function matchMermaidReviewThreadsToBlocks(
  blocks: MermaidSourceBlock[],
  threads: ReviewThread[]
): MermaidThreadMatch[][] {
  return blocks.map(block => threads
    .map(thread => ({
      threadId: thread.id,
      state: getMermaidAnchorMatchState(block, thread)
    }))
    .filter((match): match is MermaidThreadMatch => match.state !== 'none'));
}

export function getMermaidAnchorMatchState(
  block: MermaidSourceBlock,
  thread: ReviewThread
): MermaidAnchorMatchState {
  const source = normalizeAnchorText(block.source);
  const anchorText = normalizeAnchorText(thread.anchor?.text || '');

  if (!source || !anchorText) {
    return 'none';
  }

  if (anchorText === source) {
    return 'exact';
  }

  if (!source.includes(anchorText) && !anchorText.includes(source)) {
    return 'none';
  }

  return anchorOverlapsBlock(thread, block) ? 'approximate' : 'none';
}

function isClosingFence(line: string, marker: string): boolean {
  const fenceChar = marker[0];
  const minLength = marker.length;
  const pattern = new RegExp(`^\\s*\\${fenceChar}{${minLength},}\\s*$`);
  return pattern.test(line);
}

function anchorOverlapsBlock(thread: ReviewThread, block: MermaidSourceBlock): boolean {
  const blockStart = normalizeLine(block.lineStart);
  const blockEnd = normalizeLine(block.lineEnd ?? blockStart);
  const anchorStart = normalizeLine(thread.anchor?.lastLocatedLine ?? thread.anchor?.lineStart);
  const anchorEnd = normalizeLine(thread.anchor?.lineEnd ?? anchorStart);

  if (!blockStart || !blockEnd || !anchorStart || !anchorEnd) {
    return false;
  }

  return anchorStart <= blockEnd && anchorEnd >= blockStart;
}

function normalizeLine(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }

  return Math.max(1, Math.floor(value));
}
