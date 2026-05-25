export function createPreviewMarkdown(markdown: string): string {
  return hideYamlFrontMatter(markdown);
}

function hideYamlFrontMatter(markdown: string): string {
  const match = markdown.match(/^(?:\uFEFF)?[ \t]*---[ \t]*(?:\r\n|\n|\r)(?:[\s\S]*?)(?:\r\n|\n|\r)[ \t]*(?:---|\.\.\.)[ \t]*(?:(?:\r\n|\n|\r)|$)/);

  if (!match) {
    return markdown;
  }

  const frontMatter = match[0];
  return frontMatter.replace(/[^\r\n]/g, '') + markdown.slice(frontMatter.length);
}
