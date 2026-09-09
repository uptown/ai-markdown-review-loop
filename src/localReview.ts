import type * as vscode from 'vscode';
import MarkdownIt from 'markdown-it';
import { randomUUID } from 'crypto';
import type { ReviewThread } from './types';
import { hashAnchor, normalizeAnchorText } from './anchorText';

const markdown = new MarkdownIt({ html: false });

export function createLocalReviewThreads(document: vscode.TextDocument): ReviewThread[] {
  const text = document.getText();
  const lines = text.split(/\r?\n/);
  const tokens = markdown.parse(text, {});
  const codeLines = new Set<number>();
  for (const token of tokens) {
    if ((token.type === 'fence' || token.type === 'code_block') && token.map) {
      for (let line = token.map[0]; line < token.map[1]; line++) {
        codeLines.add(line);
      }
    }
  }
  const hasAcceptanceHeading = tokens.some((token, index) => {
    if (token.type !== 'heading_open' || tokens[index + 1]?.type !== 'inline') {
      return false;
    }
    const heading = (tokens[index + 1].children ?? [])
      .filter(child => child.type === 'text' || child.type === 'code_inline')
      .map(child => child.content).join('').trim().replace(/\s+/g, ' ');
    return /^(?:Acceptance(?: Criteria)?|완료 기준|검증 기준)(?:$|[\s:：—–-])/iu.test(heading);
  });
  const now = new Date().toISOString();
  const threads: ReviewThread[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (codeLines.has(index)) {
      continue;
    }
    const line = lines[index];
    const prose = (markdown.parseInline(line, {})[0]?.children ?? [])
      .filter(token => token.type === 'text')
      .map(token => token.content).join(' ');

    if (/\b(TBD|TODO|FIXME)\b/i.test(prose)) {
      threads.push(createThread(document, {
        line,
        lineNumber: index + 1,
        type: 'question',
        severity: 'medium',
        comment: 'This placeholder should be resolved or turned into an explicit open question before agent handoff.',
        now
      }));
    }

    if (prose.length > 220 && !line.trim().startsWith('|')) {
      threads.push(createThread(document, {
        line,
        lineNumber: index + 1,
        type: 'suggestion',
        severity: 'low',
        comment: 'This line is long enough to be hard to review. Consider splitting it into shorter sentences or bullets.',
        now
      }));
    }
  }

  if (!hasAcceptanceHeading) {
    const firstMeaningfulIndex = lines.findIndex((line, index) => !codeLines.has(index) && line.trim().length > 0);
    threads.push(createThread(document, {
      line: lines[firstMeaningfulIndex] ?? document.fileName,
      lineNumber: Math.max(1, firstMeaningfulIndex + 1),
      type: 'fix',
      severity: 'high',
      comment: 'Add explicit acceptance criteria so an AI agent or reviewer can tell when the document is actually satisfied.',
      now
    }));
  }

  return threads;
}

function createThread(
  document: vscode.TextDocument,
  input: {
    line: string;
    lineNumber: number;
    type: ReviewThread['type'];
    severity: ReviewThread['severity'];
    comment: string;
    now: string;
  }
): ReviewThread {
  const anchorText = input.line.trim() || document.fileName;

  return {
    id: `rv_${randomUUID()}`,
    documentUri: document.uri.toString(),
    anchor: {
      text: anchorText,
      lineStart: input.lineNumber,
      lineEnd: input.lineNumber,
      hash: hashAnchor(anchorText),
      contextBefore: getNeighborLine(document, input.lineNumber - 1),
      contextAfter: getNeighborLine(document, input.lineNumber + 1)
    },
    type: input.type,
    source: 'local',
    status: 'open',
    severity: input.severity,
    comment: input.comment,
    thread: [],
    createdAt: input.now,
    updatedAt: input.now
  };
}

function getNeighborLine(document: vscode.TextDocument, oneBasedLine: number): string | undefined {
  if (oneBasedLine < 1 || oneBasedLine > document.lineCount) {
    return undefined;
  }

  return normalizeAnchorText(document.lineAt(oneBasedLine - 1).text) || undefined;
}
