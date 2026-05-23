import TurndownService = require('turndown');
import {
  createMarkdownTableReplacement,
  type TableAlignment
} from './tableEdits';

type DomNodeLike = {
  textContent?: string | null;
};

type DomElementLike = DomNodeLike & {
  nodeName: string;
  previousSibling?: DomNodeLike | null;
  nextSibling?: DomNodeLike | null;
  getAttribute(name: string): string | null;
  querySelector(selector: string): DomElementLike | null;
  querySelectorAll(selector: string): Iterable<DomElementLike>;
};

const emptyInlineTags = new Set(['b', 'i', 'em', 'strong', 'span', 's', 'u', 'font']);

const turndown = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '*',
  strongDelimiter: '**',
  linkStyle: 'inlined'
});

turndown.addRule('emptyLink', {
  filter: node => {
    return node.nodeName.toLowerCase() === 'a' && !normalizeInlineText(node.textContent || '');
  },
  replacement: (_content, node) => {
    return boundarySpacer(node);
  }
});

turndown.addRule('emptyInline', {
  filter: node => {
    return emptyInlineTags.has(node.nodeName.toLowerCase())
      && !normalizeInlineText(node.textContent || '');
  },
  replacement: (_content, node) => {
    return boundarySpacer(node);
  }
});

turndown.addRule('taskListInput', {
  filter: node => {
    return node.nodeName.toLowerCase() === 'input'
      && String(node.getAttribute('type') || '').toLowerCase() === 'checkbox';
  },
  replacement: (_content, node) => {
    return node.getAttribute('checked') === null ? '[ ] ' : '[x] ';
  }
});

turndown.addRule('fencedCodeBlock', {
  filter: 'pre',
  replacement: (_content, node) => {
    return renderFencedCodeBlock(node);
  }
});

turndown.addRule('htmlTable', {
  filter: 'table',
  replacement: (_content, node) => {
    return renderMarkdownTable(node);
  }
});

turndown.addRule('fontCode', {
  filter: node => {
    return node.nodeName.toLowerCase() === 'font'
      && String(node.getAttribute('face') || '').toLowerCase().includes('monospace');
  },
  replacement: (_content, node) => {
    return toCodeSpan(String(node.textContent || ''));
  }
});

turndown.addRule('styleCode', {
  filter: node => {
    const style = String(node.getAttribute('style') || '').toLowerCase();
    return style.includes('font-family') && style.includes('monospace');
  },
  replacement: (_content, node) => {
    return toCodeSpan(String(node.textContent || ''));
  }
});

export function htmlBlockToMarkdown(html: string): string {
  return cleanMarkdown(turndown.turndown(html));
}

export function preserveSourceListMarker(
  sourceMarkdown: string,
  oneBasedLineStart: number,
  replacementMarkdown: string
): string {
  const sourceLine = sourceMarkdown.split(/\r?\n/)[oneBasedLineStart - 1] ?? '';
  const sourceMarker = parseListMarker(sourceLine);

  if (!sourceMarker) {
    return replacementMarkdown;
  }

  const lines = replacementMarkdown.split(/\r?\n/);
  const replacementMarker = parseListMarker(lines[0] ?? '');

  if (!replacementMarker) {
    return replacementMarkdown;
  }

  lines[0] = `${replacementMarker.indent}${sourceMarker.marker} ${replacementMarker.content}`;
  return lines.join('\n');
}

function toCodeSpan(value: string): string {
  const backtick = '`';
  const normalized = value.replace(/\s+/g, ' ').trim();
  const fence = normalized.includes(backtick) ? '``' : backtick;
  const padding = fence.length > 1 ? ' ' : '';
  return `${fence}${padding}${normalized}${padding}${fence}`;
}

function renderFencedCodeBlock(node: DomElementLike): string {
  const codeNode = node.querySelector('code') || node;
  const code = String(codeNode.textContent || '').replace(/\n$/, '');
  const language = codeLanguage(codeNode, node);
  const fence = codeFence(code);
  return `\n\n${fence}${language}\n${code}\n${fence}\n\n`;
}

function codeLanguage(codeNode: DomElementLike, preNode: DomElementLike): string {
  const candidates = [
    codeNode.getAttribute('data-language'),
    codeNode.getAttribute('class'),
    preNode.getAttribute('data-language'),
    preNode.getAttribute('class')
  ];

  for (const candidate of candidates) {
    const language = extractLanguage(candidate);

    if (language) {
      return language;
    }
  }

  return '';
}

function extractLanguage(value: string | null): string {
  if (!value) {
    return '';
  }

  const match = value.match(/(?:^|\s)(?:language|lang)-([A-Za-z0-9_+.#-]+)/)
    || value.match(/(?:^|\s)highlight-source-([A-Za-z0-9_+.#-]+)/);
  return match?.[1] ?? '';
}

function codeFence(code: string): string {
  const longestRun = Math.max(2, ...Array.from(code.matchAll(/`+/g), match => match[0].length));
  return '`'.repeat(Math.max(3, longestRun + 1));
}

function renderMarkdownTable(node: DomElementLike): string {
  const rows = Array.from(node.querySelectorAll('tr') as Iterable<DomElementLike>);
  const parsedRows = rows
    .map(row => tableCells(row))
    .filter(cells => cells.length > 0);

  if (parsedRows.length === 0) {
    return '';
  }

  const columnCount = Math.max(...parsedRows.map(row => row.length));
  const hasExplicitHeader = parsedRows[0].some(cell => cell.isHeader)
    || Boolean(node.querySelector('thead th'));
  const headers = hasExplicitHeader
    ? parsedRows[0].map(cell => cell.text)
    : Array.from({ length: columnCount }, (_, index) => `Column ${index + 1}`);
  const bodyRows = (hasExplicitHeader ? parsedRows.slice(1) : parsedRows)
    .map(row => row.map(cell => cell.text));
  const alignmentSource = parsedRows[0];
  const alignments = Array.from({ length: columnCount }, (_, index) => {
    return alignmentSource[index]?.alignment ?? 'none';
  });

  return `\n\n${createMarkdownTableReplacement({
    headers,
    alignments,
    rows: bodyRows
  })}\n\n`;
}

function tableCells(row: DomElementLike): Array<{
  text: string;
  isHeader: boolean;
  alignment: TableAlignment;
}> {
  return Array.from(row.querySelectorAll('th,td') as Iterable<DomElementLike>).map(cell => ({
    text: normalizeInlineText(cell.textContent || ''),
    isHeader: cell.nodeName.toLowerCase() === 'th',
    alignment: tableAlignment(cell)
  }));
}

function tableAlignment(cell: DomElementLike): TableAlignment {
  const align = String(cell.getAttribute('align') || '').toLowerCase();
  const style = String(cell.getAttribute('style') || '').toLowerCase();
  const value = align || style.match(/text-align\s*:\s*(left|center|right)/)?.[1] || '';

  return value === 'left' || value === 'center' || value === 'right' ? value : 'none';
}

function boundarySpacer(node: DomNodeLike): string {
  const previous = String((node as DomElementLike).previousSibling?.textContent || '');
  const next = String((node as DomElementLike).nextSibling?.textContent || '');
  const previousHasTrailingSpace = /\s$/.test(previous);
  const nextHasLeadingSpace = /^\s/.test(next);

  if (previousHasTrailingSpace && nextHasLeadingSpace) {
    return '';
  }

  return previousHasTrailingSpace || nextHasLeadingSpace ? ' ' : '';
}

function cleanMarkdown(markdown: string): string {
  return transformOutsideFencedCode(markdown, value => {
    return value
      .replace(/\[\]\([^)]*\)/g, '')
      .replace(/^[ \t]+$/gm, '')
      .replace(/^(\s*)([-+*])\s+(?=\S)/gm, '$1$2 ')
      .replace(/^(\s*)(\d+\.)\s+(?=\S)/gm, '$1$2 ')
      .split('\n')
      .map(collapseNonTableLineSpaces)
      .join('\n')
      .replace(/\n{3,}/g, '\n\n');
  }).trim();
}

function collapseNonTableLineSpaces(line: string): string {
  if (/^\s*\|/.test(line)) {
    return line;
  }

  const leadingWhitespace = line.match(/^\s*/)?.[0] ?? '';
  return leadingWhitespace + line.slice(leadingWhitespace.length).replace(/[ \t]{2,}(?=\S)/g, ' ');
}

function transformOutsideFencedCode(
  markdown: string,
  transform: (value: string) => string
): string {
  const fencePattern = /(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\2(?=\n|$)/g;
  let cursor = 0;
  let output = '';
  let match: RegExpExecArray | null;

  while ((match = fencePattern.exec(markdown)) !== null) {
    output += transform(markdown.slice(cursor, match.index));
    output += match[0];
    cursor = match.index + match[0].length;
  }

  output += transform(markdown.slice(cursor));
  return output;
}

function normalizeInlineText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function parseListMarker(line: string): {
  indent: string;
  marker: string;
  content: string;
} | undefined {
  const ordered = line.match(/^(\s*)(\d+[.)])\s+(.*)$/);

  if (ordered) {
    return {
      indent: ordered[1],
      marker: ordered[2],
      content: ordered[3]
    };
  }

  const unordered = line.match(/^(\s*)([-+*])\s+(.*)$/);

  if (unordered) {
    return {
      indent: unordered[1],
      marker: unordered[2],
      content: unordered[3]
    };
  }

  return undefined;
}
