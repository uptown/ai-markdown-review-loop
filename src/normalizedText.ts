/** Map a match in whitespace-collapsed, trimmed text back to its raw span. */
export function findNormalizedTextSpan(
  raw: string,
  needle: string,
  normalizedIndex: number
): { start: number; length: number } | undefined {
  let normalized = '';
  const starts: number[] = [];
  const ends: number[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    if (/\s/.test(raw[index])) {
      if (!normalized.length) {
        continue;
      }
      if (normalized.endsWith(' ')) {
        ends[ends.length - 1] = index + 1;
      } else {
        normalized += ' ';
        starts.push(index);
        ends.push(index + 1);
      }
    } else {
      normalized += raw[index];
      starts.push(index);
      ends.push(index + 1);
    }
  }
  normalized = normalized.trimEnd();
  if (!needle || normalizedIndex < 0 || !Number.isInteger(normalizedIndex)
    || normalized.slice(normalizedIndex, normalizedIndex + needle.length) !== needle) {
    return undefined;
  }
  const start = starts[normalizedIndex];
  return { start, length: ends[normalizedIndex + needle.length - 1] - start };
}
