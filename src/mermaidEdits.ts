export function createMermaidFenceReplacement(source: string): string {
  const normalizedSource = unwrapMermaidFence(source.replace(/\r\n?/g, '\n').trim());
  return ['```mermaid', normalizedSource, '```'].join('\n');
}

function unwrapMermaidFence(source: string): string {
  const match = source.match(/^```(?:mermaid)?\s*\n([\s\S]*?)\n```$/i);
  return match ? match[1].trim() : source;
}
