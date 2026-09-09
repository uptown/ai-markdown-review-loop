import TurndownService = require('turndown');
import { randomUUID } from 'crypto';
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

export interface HtmlBlockSourceContext {
  sourceMarkdown: string;
  oneBasedLineStart: number;
}

function createTurndown(preserve: (markdown: string) => string): TurndownService {
  const turndown = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
    strongDelimiter: '**',
    linkStyle: 'inlined',
    preformattedCode: true,
    blankReplacement: (_content, node) => {
      if (node.getAttribute('data-markdown-image') !== null) {
        return preserve(originalImageMarkdown(node));
      }
      if (node.nodeName === 'CODE') {
        return preserve(toCodeSpan(String(node.textContent || '')));
      }
      return (node as unknown as { isBlock: boolean }).isBlock ? '\n\n' : '';
    }
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
      return preserve(toCodeSpan(String(node.textContent || '')));
    }
  });

  turndown.addRule('styleCode', {
    filter: node => {
      const style = String(node.getAttribute('style') || '').toLowerCase();
      return node.nodeName !== 'PRE' && style.includes('font-family') && style.includes('monospace');
    },
    replacement: (_content, node) => {
      return preserve(toCodeSpan(String(node.textContent || '')));
    }
  });

  turndown.addRule('inlineCode', {
    filter: node => node.nodeName === 'CODE' && node.parentNode?.nodeName !== 'PRE',
    replacement: (_content, node) => preserve(toCodeSpan(String(node.textContent || '')))
  });

  turndown.addRule('reviewImage', {
    filter: node => node.getAttribute('data-markdown-image') !== null,
    replacement: (_content, node) => preserve(originalImageMarkdown(node))
  });

  return turndown;
}

export function htmlBlockToMarkdown(
  html: string,
  sourceContext?: HtmlBlockSourceContext
): string {
  const protectedParts: string[] = [];
  const prefix = `AMRL${randomUUID().replace(/-/g, '')}Q`;
  const preserve = (markdown: string) => markdown.split('\n').map(line => {
    const index = protectedParts.push(line) - 1;
    return `${prefix}${index}Z`;
  }).join('\n');
  const turndown = createTurndown(preserve);
  const markdown = cleanMarkdown(turndown.turndown(normalizeRichCodeElements(html)));
  const contextualMarkdown = sourceContext ? preserveSourceBlockSyntax(markdown, sourceContext) : markdown;
  return contextualMarkdown.replace(new RegExp(`${prefix}(\\d+)Z`, 'g'), (_match, index: string) => protectedParts[Number(index)]);
}

function toCodeSpan(value: string): string {
  if (!value) {
    return '';
  }

  const normalized = value.replace(/\r\n|\r|\n/g, ' ');
  const longestRun = Math.max(0, ...Array.from(normalized.matchAll(/`+/g), match => match[0].length));
  const fence = '`'.repeat(longestRun + 1);
  const needsPadding = normalized.startsWith('`') || normalized.endsWith('`')
    || (normalized.startsWith(' ') && normalized.endsWith(' '));
  const padding = needsPadding ? ' ' : '';
  return `${fence}${padding}${normalized}${padding}${fence}`;
}

function originalImageMarkdown(node: DomElementLike): string {
  const original = node.getAttribute('data-image-markdown');
  if (original !== null) {
    return original;
  }

  const src = node.getAttribute('data-image-src');
  if (src === null) {
    throw new Error('Cannot save this image without its original image source. Reopen the block editor.');
  }

  const alt = String(node.getAttribute('data-image-alt') || '').replace(/([\\[\]])/g, '\\$1');
  const escapedDestination = src.replace(/([\\<>()])/g, '\\$1');
  const destination = /\s/.test(escapedDestination) ? `<${escapedDestination}>` : escapedDestination;
  const title = node.getAttribute('data-image-title') || '';
  const titleSuffix = title ? ` "${title.replace(/([\\"])/g, '\\$1')}"` : '';
  return `![${alt}](${destination}${titleSuffix})`;
}

// Normalize browser-produced monospace wrappers before Turndown's whitespace pass.
// A rule alone runs too late: Turndown collapses FONT/SPAN text before dispatching it.
function normalizeRichCodeElements(html: string): string {
  const stack: Array<{ original: string; replacement: string }> = [];
  return html.replace(/<!--[\s\S]*?-->|<\/?([A-Za-z][\w:-]*)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/g, (tag, name: string | undefined) => {
    if (!name) {
      return tag;
    }
    const original = name.toLowerCase();
    if (tag.startsWith('</')) {
      const index = stack.map(entry => entry.original).lastIndexOf(original);
      if (index < 0) {
        return tag;
      }
      const entry = stack[index];
      stack.splice(index);
      return entry.replacement === original ? tag : `</${entry.replacement}>`;
    }

    const readAttribute = (attribute: string) => {
      const match = tag.match(new RegExp(`\\s${attribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\x60]+))`, 'i'));
      return (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').toLowerCase();
    };
    const monospace = (original === 'font' && readAttribute('face').includes('monospace'))
      || /font-family\s*:[^;]*monospace/.test(readAttribute('style'));
    const replacement = monospace && original !== 'pre' ? 'code' : original;
    if (!/^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/.test(original) && !/\/\s*>$/.test(tag)) {
      stack.push({ original, replacement });
    }
    return replacement === original ? tag : tag.replace(/^<[A-Za-z][\w:-]*/, `<${replacement}`);
  });
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

function preserveSourceBlockSyntax(
  replacementMarkdown: string,
  sourceContext: HtmlBlockSourceContext
): string {
  const sourceLine = sourceContext.sourceMarkdown.split(/\r?\n/)[sourceContext.oneBasedLineStart - 1] ?? '';
  const sourceMarker = parseListMarker(sourceLine);

  if (!sourceMarker) {
    return replacementMarkdown;
  }

  const lines = replacementMarkdown.split(/\r?\n/);
  const replacementMarker = parseListMarker(lines[0] ?? '');

  if (!replacementMarker) {
    return replacementMarkdown;
  }

  lines[0] = `${sourceMarker.indent}${sourceMarker.marker} ${replacementMarker.content}`;

  for (let index = 1; index < lines.length; index += 1) {
    if (sourceMarker.indent && lines[index].trim()) {
      lines[index] = `${sourceMarker.indent}${lines[index]}`;
    }
  }

  return lines.join('\n');
}
