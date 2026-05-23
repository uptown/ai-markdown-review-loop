export const AGENT_REVIEW_POLICY_DOC_PATH = 'docs/AI-REVIEW-POLICY.md';
export const AGENT_REVIEW_THREAD_SCHEMA_PATH = 'docs/agent-review-thread.schema.json';
export const AGENT_COLLABORATION_LOOP_DOC_PATH = 'docs/AI-COLLABORATION-LOOP.md';
export const AGENT_CONTEXT_BOOTSTRAP_DOC_PATH = 'docs/AI-CONTEXT-BOOTSTRAP.md';

export const AGENT_EDITING_GUIDELINES = [
  'Treat the Markdown document and its review sidecar as one review state.',
  'Work on open review threads only unless the user explicitly asks you to inspect closed history.',
  'Preserve the document-level `ai-review-anchors` marker unless the user explicitly asks to clean stale anchors.',
  'Preserve `ai-review-log` audit comments and colocated `.<filename>.ai-review.json` sidecar files during normal document editing.',
  'Prefer localized edits over whole-document rewrites so anchors can keep tracking nearby content.',
  'When editing text with open feedback, keep enough nearby context stable for anchor recovery.',
  'Do not silently delete or rewrite open review comments. If a comment no longer matches after your edit, call that out and leave it open for re-anchor.',
  'Use replies to discuss, clarify, or challenge feedback. If you disagree, propose a reply or objection instead of ignoring the thread.',
  'Do not mark a thread `accepted`, `resolved`, or `rejected` on behalf of the user unless they explicitly ask you to close it.',
  'Report every handled `rv_*` ID in your response with an outcome: applied, partially applied, replied, needs user decision, or blocked.'
];

export const AGENT_COMMENTING_GUIDELINES = [
  'Comment on material issues only: correctness, ambiguity, missing ownership, missing acceptance criteria, contradiction, hidden implementation risk, or unverifiable requirements.',
  'Do not open new threads for style nits, wording preferences, praise-only observations, or problems already captured by an existing open thread.',
  'Create one issue per thread. If two concerns need different actions, split them into separate threads.',
  'Prefer `question` when the document is blocked by missing information, `risk` when downstream implementation is likely to fail, `fix` when the document is plainly incorrect, `suggestion` when you can offer a safe localized patch, and `note` for non-blocking but real improvements.',
  'Use `high` severity only for release-blocking ambiguity, factual incorrectness, or likely implementation failure. Use `medium` for material but bounded issues. Use `low` for non-blocking improvements.',
  'Anchor the smallest stable text span that proves the issue. Avoid anchoring entire sections when one sentence or phrase is enough.',
  'Only include a suggested patch when the fix is localized, low-risk, and can be expressed as one replace operation without changing surrounding intent.',
  'If the best move is to continue an existing discussion, prefer a reply on the relevant `rv_*` thread instead of opening a duplicate thread.'
];

export const AGENT_THREAD_CREATION_CONTRACT = [
  `Canonical review policy: ${AGENT_REVIEW_POLICY_DOC_PATH}`,
  `Canonical creation schema: ${AGENT_REVIEW_THREAD_SCHEMA_PATH}`,
  'When proposing a new AI-authored review thread, emit one JSON object per proposed thread.',
  'The host system owns `id`, `documentUri`, `createdAt`, and `updatedAt`; do not invent or guess those values.',
  'Always set `source` to `ai` and `status` to `open`.',
  'Required fields for new threads are `anchor`, `type`, `severity`, and `comment`.',
  'Optional `suggestedPatch` must use `mode: "replace"` with one `original` string and one `replacement` string.'
];

export const AGENT_COLLABORATION_LOOP_GUIDELINES = [
  `Canonical collaboration loop: ${AGENT_COLLABORATION_LOOP_DOC_PATH}`,
  'The human provides goals, domain constraints, objections, and final review decisions.',
  'The AI proposes issues, candidate edits, clarifying questions, and draft replies, but does not own final closure decisions.',
  'Use review replies as the negotiation surface: AI can refine or challenge prior feedback there instead of replacing thread history.',
  'When a human reply changes the interpretation of a thread, the AI should continue the same thread unless the issue has clearly split into separate concerns.',
  'The loop is: bootstrap context, review, human reply or edit, AI follow-up, then explicit human closure or carry-forward.'
];

export const AGENT_CONTEXT_BOOTSTRAP_GUIDELINES = [
  `Canonical context bootstrap: ${AGENT_CONTEXT_BOOTSTRAP_DOC_PATH}`,
  'Before the first AI review pass, start from the current Markdown target and read shared repo context that is available to an AI agent, such as `README.md`, `docs/AI-CONTEXT-BRIEF.md`, and the AI Markdown Review Loop policy docs.',
  'Human onboarding should start from a short bootstrap prompt, not from a status panel or a blank context file.',
  'The bootstrap prompt should work with any AI agent: read repo docs, ask only for missing context, use AI Markdown Review Loop tools when available, and preserve colocated sidecar review metadata during Markdown edits.',
  'If `docs/AI-CONTEXT-BRIEF.md` is missing or stale, the AI can draft or refresh it, but brief creation is not the only outcome of bootstrap.',
  'If the available context does not provide enough context, ask the human for the missing pieces instead of guessing.',
  'The minimum context packet is: product goal, intended audience, hard constraints, non-goals, canonical source docs, and current open decisions.',
  'Treat explicit user replies in review threads as newer context than older project docs when they conflict.',
  'If key context is missing, prefer opening `question` threads over pretending the requirement is settled.'
];

export const AGENT_CONTEXT_BRIEF_TEMPLATE = `# AI Context Brief

- Product goal:
- Intended audience:
- Hard constraints:
- Non-goals:
- Canonical source docs:
- Current open decisions:
- Review focus for this pass:
`;

export const AGENT_THREAD_CREATION_EXAMPLE = `{
  "source": "ai",
  "status": "open",
  "type": "risk",
  "severity": "medium",
  "anchor": {
    "text": "The service should retry failures automatically.",
    "lineStart": 18,
    "lineEnd": 18,
    "occurrence": 0,
    "contextBefore": "Failure handling",
    "contextAfter": "Operational notes"
  },
  "comment": "This requirement says retries happen automatically, but it does not define retry count, backoff, or what happens after the final failure. That leaves implementation and operational behavior ambiguous.",
  "suggestedPatch": {
    "mode": "replace",
    "original": "The service should retry failures automatically.",
    "replacement": "The service should retry failed requests up to 3 times with exponential backoff before surfacing the failure to the caller."
  }
}`;
