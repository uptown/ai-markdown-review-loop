import TurndownService = require('turndown');

const turndown = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '*',
  strongDelimiter: '**',
  linkStyle: 'inlined'
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
  return turndown
    .turndown(html)
    .replace(/^[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function toCodeSpan(value: string): string {
  const backtick = '`';
  const normalized = value.replace(/\s+/g, ' ').trim();
  const fence = normalized.includes(backtick) ? '``' : backtick;
  const padding = fence.length > 1 ? ' ' : '';
  return `${fence}${padding}${normalized}${padding}${fence}`;
}
