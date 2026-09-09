import MarkdownIt from 'markdown-it';

// Obtain the built-in image parser through Ruler's public API. The preview uses
// MarkdownIt's standard image grammar; retaining its consumed source avoids
// reconstructing escaped destinations, titles, or reference image syntax.
const imageRules = new MarkdownIt().inline.ruler;
imageRules.enableOnly('image');
const parseImage = imageRules.getRules('')[0];

export function applyMarkdownImageSourceMapping(markdown: MarkdownIt): void {
  markdown.inline.ruler.at('image', (state, silent) => {
    const start = state.pos;
    const matched = parseImage(state, silent);

    if (matched && !silent) {
      const token = state.tokens[state.tokens.length - 1];
      token.meta = { ...token.meta, reviewSourceMarkdown: state.src.slice(start, state.pos) };
    }

    return matched;
  });
}
