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

export interface MarkdownTableAnchorCandidate {
  text: string;
  start: number;
  length: number;
}

interface CellAnchorCandidate {
  text: string;
  start: number;
  length: number;
}

interface SourceTableCell {
  tableLineIndex: number;
  columnIndex: number;
  text: string;
}

interface MarkdownTableCellRange {
  start: number;
  end: number;
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

export function findTableAnchorReplacementCandidate(
  editedTableMarkdown: string,
  replacementTableMarkdown: string,
  anchorText: string,
  preferredTableLineIndex?: number
): MarkdownTableAnchorCandidate | undefined {
  const sourceTable = parseMarkdownTableLines(editedTableMarkdown.replace(/\r\n?/g, '\n').split('\n'));
  const replacementTable = parseMarkdownTableLines(
    replacementTableMarkdown.replace(/\r\n?/g, '\n').split('\n')
  );

  if (!sourceTable || !replacementTable) {
    return undefined;
  }

  const sourceCell = findSourceTableCell(sourceTable, anchorText, preferredTableLineIndex);

  if (!sourceCell) {
    return undefined;
  }

  const replacementCellText = cellTextAt(replacementTable, sourceCell.tableLineIndex, sourceCell.columnIndex);

  if (!replacementCellText) {
    return undefined;
  }

  const cellCandidate = findCellAnchorCandidate(sourceCell.text, replacementCellText, anchorText);

  if (!cellCandidate) {
    return undefined;
  }

  return createReplacementCellAnchorCandidate(
    replacementTableMarkdown.replace(/\r\n?/g, '\n'),
    sourceCell.tableLineIndex,
    sourceCell.columnIndex,
    replacementCellText,
    cellCandidate
  );
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

function findSourceTableCell(
  table: MarkdownTableData,
  anchorText: string,
  preferredTableLineIndex?: number
): SourceTableCell | undefined {
  const anchor = normalizeComparableText(anchorText);

  if (!anchor) {
    return undefined;
  }

  const cells = tableCells(table);
  const candidates = cells.flatMap(row => row.cells
    .map((text, columnIndex) => ({
      tableLineIndex: row.tableLineIndex,
      columnIndex,
      text,
      score: sourceCellMatchScore(text, anchorText, preferredTableLineIndex, row.tableLineIndex)
    }))
    .filter(candidate => candidate.score < Number.POSITIVE_INFINITY));

  candidates.sort((left, right) => left.score - right.score);
  return candidates[0]
    ? {
        tableLineIndex: candidates[0].tableLineIndex,
        columnIndex: candidates[0].columnIndex,
        text: candidates[0].text
      }
    : undefined;
}

function sourceCellMatchScore(
  cellText: string,
  anchorText: string,
  preferredTableLineIndex: number | undefined,
  tableLineIndex: number
): number {
  const normalizedCell = normalizeComparableText(cellText);
  const normalizedAnchor = normalizeComparableText(anchorText);

  if (!normalizedAnchor) {
    return Number.POSITIVE_INFINITY;
  }

  let score = Number.POSITIVE_INFINITY;

  if (cellText === anchorText) {
    score = 0;
  } else if (normalizedCell === normalizedAnchor) {
    score = 10;
  } else if (cellText.includes(anchorText)) {
    score = 20;
  } else if (normalizedCell.includes(normalizedAnchor)) {
    score = 30;
  }

  if (score === Number.POSITIVE_INFINITY || preferredTableLineIndex === undefined) {
    return score;
  }

  return score + (Math.abs(tableLineIndex - preferredTableLineIndex) * 100);
}

function findCellAnchorCandidate(
  sourceCellText: string,
  replacementCellText: string,
  anchorText: string
): CellAnchorCandidate | undefined {
  const exactReplacementStart = replacementCellText.indexOf(anchorText);

  if (exactReplacementStart >= 0) {
    return {
      text: replacementCellText.slice(exactReplacementStart, exactReplacementStart + anchorText.length),
      start: exactReplacementStart,
      length: anchorText.length
    };
  }

  const exactSourceStart = sourceCellText.indexOf(anchorText);

  if (exactSourceStart >= 0) {
    const prefix = sourceCellText.slice(0, exactSourceStart);
    const suffix = sourceCellText.slice(exactSourceStart + anchorText.length);

    if (replacementCellText.startsWith(prefix) && replacementCellText.endsWith(suffix)) {
      const start = prefix.length;
      const end = replacementCellText.length - suffix.length;

      if (end > start) {
        return {
          text: replacementCellText.slice(start, end),
          start,
          length: end - start
        };
      }
    }
  }

  if (normalizeComparableText(sourceCellText) === normalizeComparableText(anchorText)) {
    return {
      text: replacementCellText,
      start: 0,
      length: replacementCellText.length
    };
  }

  return undefined;
}

function createReplacementCellAnchorCandidate(
  replacementTableMarkdown: string,
  tableLineIndex: number,
  columnIndex: number,
  replacementCellText: string,
  cellCandidate: CellAnchorCandidate
): MarkdownTableAnchorCandidate | undefined {
  const lines = replacementTableMarkdown.split('\n');
  const targetLine = lines[tableLineIndex];

  if (targetLine === undefined) {
    return undefined;
  }

  const ranges = splitMarkdownTableRowRanges(targetLine);
  const range = ranges[columnIndex];

  if (!range) {
    return undefined;
  }

  const serializedCellText = serializeCell(replacementCellText);
  const serializedCellStart = targetLine.slice(range.start, range.end).indexOf(serializedCellText);

  if (serializedCellStart < 0) {
    return undefined;
  }

  const contentStart = range.start + serializedCellStart;
  const serializedStart = contentStart
    + displayOffsetToSerializedOffset(serializedCellText, cellCandidate.start);
  const serializedEnd = contentStart
    + displayOffsetToSerializedOffset(serializedCellText, cellCandidate.start + cellCandidate.length);
  const lineStart = lineStartOffset(replacementTableMarkdown, tableLineIndex);

  return {
    text: cellCandidate.text,
    start: lineStart + serializedStart,
    length: Math.max(0, serializedEnd - serializedStart)
  };
}

function tableCells(table: MarkdownTableData): Array<{
  tableLineIndex: number;
  cells: string[];
}> {
  return [
    {
      tableLineIndex: 0,
      cells: table.headers
    },
    ...table.rows.map((cells, rowIndex) => ({
      tableLineIndex: rowIndex + 2,
      cells
    }))
  ];
}

function cellTextAt(
  table: MarkdownTableData,
  tableLineIndex: number,
  columnIndex: number
): string | undefined {
  const row = tableLineIndex === 0
    ? table.headers
    : table.rows[tableLineIndex - 2];
  return row?.[columnIndex];
}

function splitMarkdownTableRowRanges(line: string): MarkdownTableCellRange[] {
  if (!line.includes('|')) {
    return [];
  }

  const ranges: MarkdownTableCellRange[] = [];
  let cellStart = line.startsWith('|') ? 1 : 0;
  let codeFenceLength = 0;

  for (let index = cellStart; index < line.length; index += 1) {
    const character = line[index];

    if (character === '`' && !isEscaped(line, index)) {
      const fenceLength = countBackticks(line, index);

      if (codeFenceLength === 0) {
        codeFenceLength = fenceLength;
      } else if (fenceLength === codeFenceLength) {
        codeFenceLength = 0;
      }

      index += fenceLength - 1;
      continue;
    }

    if (character === '|' && codeFenceLength === 0 && !isEscaped(line, index)) {
      ranges.push(createCellRange(line, cellStart, index));
      cellStart = index + 1;
    }
  }

  if (cellStart < line.length) {
    ranges.push(createCellRange(line, cellStart, line.length));
  }

  return ranges;
}

function createCellRange(line: string, start: number, end: number): MarkdownTableCellRange {
  let contentStart = start;
  let contentEnd = end;

  while (contentStart < contentEnd && /\s/.test(line[contentStart])) {
    contentStart += 1;
  }

  while (contentEnd > contentStart && /\s/.test(line[contentEnd - 1])) {
    contentEnd -= 1;
  }

  return {
    start: contentStart,
    end: contentEnd
  };
}

function displayOffsetToSerializedOffset(serializedText: string, displayOffset: number): number {
  let displayCursor = 0;

  for (let index = 0; index < serializedText.length; index += 1) {
    if (displayCursor >= displayOffset) {
      return index;
    }

    if (serializedText[index] === '\\' && serializedText[index + 1] === '|') {
      index += 1;
    }

    displayCursor += 1;
  }

  return serializedText.length;
}

function lineStartOffset(text: string, zeroBasedLineIndex: number): number {
  if (zeroBasedLineIndex <= 0) {
    return 0;
  }

  let lineIndex = 0;

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '\n') {
      continue;
    }

    lineIndex += 1;

    if (lineIndex === zeroBasedLineIndex) {
      return index + 1;
    }
  }

  return text.length;
}

function normalizeComparableText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
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
