import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { ReviewThread } from './types';
import { hashAnchor, normalizeAnchorText } from './anchors';

export function createLocalReviewThreads(document: vscode.TextDocument): ReviewThread[] {
  const text = document.getText();
  const lines = text.split(/\r?\n/);
  const now = new Date().toISOString();
  const threads: ReviewThread[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (/\b(TBD|TODO|FIXME)\b/i.test(line)) {
      threads.push(createThread(document, {
        line,
        lineNumber: index + 1,
        type: 'question',
        severity: 'medium',
        comment: 'This placeholder should be resolved or turned into an explicit open question before agent handoff.',
        now
      }));
    }

    if (line.length > 220 && !line.trim().startsWith('|')) {
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

  if (!/^#{1,3}\s+(Acceptance Criteria|Acceptance|완료 기준|검증 기준)\b/im.test(text)) {
    const firstMeaningfulLine = lines.find(line => line.trim().length > 0) ?? document.fileName;
    threads.push(createThread(document, {
      line: firstMeaningfulLine,
      lineNumber: Math.max(1, lines.findIndex(line => line === firstMeaningfulLine) + 1),
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
