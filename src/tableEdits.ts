export type TableAlignment = 'none' | 'left' | 'center' | 'right';

export interface MarkdownTableData {
  headers: string[];
  alignments: TableAlignment[];
  rows: string[][];
}

export interface MarkdownTableBlock extends MarkdownTableData {
  lineStart: number;
  lineEnd: number;
}

export function collectMarkdownTables(markdown: string): MarkdownTableBlock[] {
  const normalizedMarkdown = markdown.replace(/\r\n?/g, '\n');
  const lines = normalizedMarkdown.split('\n');
  const tables: MarkdownTableBlock[] = [];

  for (let index = 0; index < lines.length - 1; index += 1) {
    if (!isTableRow(lines[index]) || !isSeparatorLine(lines[index + 1])) {
      continue;
    }

    let endIndex = index + 2;

    while (endIndex < lines.length && isTableRow(lines[endIndex])) {
      endIndex += 1;
    }

    const parsed = parseMarkdownTableLines(lines.slice(index, endIndex));

    if (parsed) {
      tables.push({
        ...parsed,
        lineStart: index + 1,
        lineEnd: endIndex
      });
    }

    index = endIndex - 1;
  }

  return tables;
}

export function createMarkdownTableReplacement(input: {
  headers?: unknown;
  alignments?: unknown;
  rows?: unknown;
}): string {
  const table = normalizeMarkdownTableData(input);
  const columnWidths = table.headers.map((header, columnIndex) => {
    const bodyWidth = table.rows.reduce((width, row) => {
      return Math.max(width, serializeCell(row[columnIndex] ?? '').length);
    }, 0);
    return Math.max(
      3,
      serializeCell(header).length,
      bodyWidth,
      separatorCell(table.alignments[columnIndex]).length
    );
  });

  return [
    formatTableRow(table.headers, columnWidths),
    formatSeparatorRow(table.alignments, columnWidths),
    ...table.rows.map(row => formatTableRow(row, columnWidths))
  ].join('\n');
}

export function normalizeMarkdownTableData(input: {
  headers?: unknown;
  alignments?: unknown;
  rows?: unknown;
}): MarkdownTableData {
  const headers = Array.isArray(input.headers) ? input.headers.map(toCellText) : [];
  const alignments = Array.isArray(input.alignments)
    ? input.alignments.map(toAlignment)
    : [];
  const rows = Array.isArray(input.rows)
    ? input.rows.filter(Array.isArray).map(row => row.map(toCellText))
    : [];
  const columnCount = Math.max(
    1,
    headers.length,
    alignments.length,
    ...rows.map(row => row.length)
  );

  return {
    headers: padCells(headers, columnCount),
    alignments: padAlignments(alignments, columnCount),
    rows: rows.map(row => padCells(row, columnCount))
  };
}

function parseMarkdownTableLines(lines: string[]): MarkdownTableData | undefined {
  if (lines.length < 2 || !isSeparatorLine(lines[1])) {
    return undefined;
  }

  const headers = splitMarkdownTableRow(lines[0]);
  const alignments = splitMarkdownTableRow(lines[1]).map(parseAlignment);
  const rows = lines.slice(2).map(splitMarkdownTableRow);

  return normalizeMarkdownTableData({
    headers,
    alignments,
    rows
  });
}

function isTableRow(line: string): boolean {
  return splitMarkdownTableRow(line).length > 1;
}

function isSeparatorLine(line: string): boolean {
  const cells = splitMarkdownTableRow(line);
  return cells.length > 1 && cells.every(cell => /^:?-{3,}:?$/.test(cell.trim()));
}

function splitMarkdownTableRow(line: string): string[] {
  let value = line.trim();

  if (!value.includes('|')) {
    return [];
  }

  if (value.startsWith('|')) {
    value = value.slice(1);
  }

  if (value.endsWith('|') && !isEscaped(value, value.length - 1)) {
    value = value.slice(0, -1);
  }

  const cells: string[] = [];
  let cell = '';
  let codeFenceLength = 0;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];

    if (character === '`' && !isEscaped(value, index)) {
      const fenceLength = countBackticks(value, index);

      if (codeFenceLength === 0) {
        codeFenceLength = fenceLength;
      } else if (fenceLength === codeFenceLength) {
        codeFenceLength = 0;
      }

      cell += value.slice(index, index + fenceLength);
      index += fenceLength - 1;
      continue;
    }

    if (character === '|' && codeFenceLength === 0 && !isEscaped(value, index)) {
      cells.push(cleanCell(cell));
      cell = '';
      continue;
    }

    cell += character;
  }

  cells.push(cleanCell(cell));
  return cells;
}

function cleanCell(value: string): string {
  return value.trim().replace(/\\\|/g, '|');
}

function countBackticks(value: string, start: number): number {
  let count = 0;

  while (value[start + count] === '`') {
    count += 1;
  }

  return count;
}

function isEscaped(value: string, index: number): boolean {
  let slashCount = 0;

  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) {
    slashCount += 1;
  }

  return slashCount % 2 === 1;
}

function parseAlignment(value: string): TableAlignment {
  const cell = value.trim();
  const starts = cell.startsWith(':');
  const ends = cell.endsWith(':');

  if (starts && ends) {
    return 'center';
  }

  if (starts) {
    return 'left';
  }

  if (ends) {
    return 'right';
  }

  return 'none';
}

function toAlignment(value: unknown): TableAlignment {
  return value === 'left' || value === 'center' || value === 'right' ? value : 'none';
}

function toCellText(value: unknown): string {
  return String(value ?? '').replace(/\r?\n/g, ' ').trim();
}

function padCells(cells: string[], columnCount: number): string[] {
  return Array.from({ length: columnCount }, (_, index) => cells[index] ?? '');
}

function padAlignments(alignments: TableAlignment[], columnCount: number): TableAlignment[] {
  return Array.from({ length: columnCount }, (_, index) => alignments[index] ?? 'none');
}

function formatTableRow(cells: string[], columnWidths: number[]): string {
  return `| ${cells.map((cell, index) => padCell(serializeCell(cell), columnWidths[index])).join(' | ')} |`;
}

function formatSeparatorRow(alignments: TableAlignment[], columnWidths: number[]): string {
  return `| ${alignments.map((alignment, index) => padCell(separatorCell(alignment), columnWidths[index])).join(' | ')} |`;
}

function serializeCell(value: string): string {
  return toCellText(value).replace(/\|/g, '\\|');
}

function padCell(value: string, width: number): string {
  return value.padEnd(width, ' ');
}

function separatorCell(alignment: TableAlignment): string {
  if (alignment === 'left') {
    return ':---';
  }

  if (alignment === 'center') {
    return ':---:';
  }

  if (alignment === 'right') {
    return '---:';
  }

  return '---';
}
