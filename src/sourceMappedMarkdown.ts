import type MarkdownIt from 'markdown-it';

export const sourceMappedRuleNames = [
  'paragraph_open',
  'heading_open',
  'blockquote_open',
  'bullet_list_open',
  'ordered_list_open',
  'list_item_open',
  'table_open',
  'tr_open'
];

export function applySourceLineMapping(markdown: MarkdownIt): void {
  for (const ruleName of sourceMappedRuleNames) {
    const defaultRule = markdown.renderer.rules[ruleName];

    markdown.renderer.rules[ruleName] = (tokens, index, options, env, self) => {
      const token = tokens[index];
      const sourceLine = token.map?.[0];
      const sourceLineEnd = token.map?.[1];

      if (typeof sourceLine === 'number') {
        token.attrSet('data-source-line', String(sourceLine + 1));
      }

      if (typeof sourceLineEnd === 'number') {
        token.attrSet('data-source-line-end', String(sourceLineEnd));
      }

      if (defaultRule) {
        return defaultRule(tokens, index, options, env, self);
      }

      return self.renderToken(tokens, index, options);
    };
  }
}
