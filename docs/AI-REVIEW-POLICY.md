# AI Review Policy

This document defines how AI reviewers should create, discuss, and hand off
review feedback inside AI Markdown Review Loop. The goal is to keep AI-written
threads useful, low-noise, and structurally compatible with the review system.

## Purpose

AI review is for material document quality issues, not for generic proofreading.
An AI review comment should help an author or downstream agent make a better
product, implementation, or decision.

## What AI Should Comment On

AI should create review threads for issues such as:

- factual incorrectness
- ambiguity that blocks implementation or verification
- missing ownership, acceptance criteria, or operational behavior
- contradictions between nearby requirements
- hidden implementation, testing, rollout, or support risk
- incomplete suggested behavior that could produce inconsistent code

## What AI Should Not Comment On

AI should not create review threads for:

- style-only nits
- subjective wording preferences
- praise-only observations
- duplicate issues already covered by an open thread
- speculative concerns without document evidence
- large rewrite requests when a localized clarification would do

## Thread Type Rules

Use `fix` when the current text is plainly incorrect and needs correction.

Use `question` when the document is missing information and the safest next step
is to ask for clarification.

Use `risk` when the document is likely to cause bad implementation, rollout, or
support outcomes if left unchanged.

Use `suggestion` when the issue can be addressed with a safe, localized, mostly
mechanical patch.

Use `note` for non-blocking but still real improvements that should be surfaced
without overstating severity.

## Severity Rules

Use `high` only for release-blocking ambiguity, incorrectness, or likely
implementation failure.

Use `medium` for issues that are material and actionable, but bounded in blast
radius.

Use `low` for non-blocking improvements that still deserve review attention.

## Anchor Rules

- Anchor the smallest stable text span that proves the issue.
- Prefer one sentence or phrase over a full section when possible.
- Include line hints and nearby context when available.
- Avoid anchors that mix multiple independent issues into one thread.

## Comment Writing Rules

- One thread should represent one actionable issue.
- The comment should explain why the text is a problem, not just that it feels weak.
- Prefer concrete consequences over generic critique.
- If the right action is to continue an existing conversation, reply to the existing `rv_*` thread instead of creating a duplicate.

## Suggested Patch Rules

- Only attach a suggested patch when the change is localized and low-risk.
- The patch must fit one replace operation.
- Do not use a suggested patch for broad restructuring, tone rewrites, or multi-issue fixes.
- If a safe patch is not obvious, create a `question` or `risk` thread instead.

## Review State Rules

- New AI-authored threads should start as `source: "ai"` and `status: "open"`.
- AI must not close threads as `accepted`, `resolved`, or `rejected` unless the user explicitly asks for that decision.
- AI should preserve inline review metadata and colocated `.<filename>.ai-review.json` sidecar review files during normal edits.

## Machine Contract

Future AI-created thread proposals should conform to:

- Schema: [`docs/agent-review-thread.schema.json`](./agent-review-thread.schema.json)

The host system assigns `id`, `documentUri`, `createdAt`, and `updatedAt`.
AI proposals should provide the semantic payload: anchor, type, severity,
comment, and optional suggested patch.

## Example Good Thread

```json
{
  "source": "ai",
  "status": "open",
  "type": "question",
  "severity": "medium",
  "anchor": {
    "text": "The service should retry failures automatically.",
    "lineStart": 18,
    "lineEnd": 18
  },
  "comment": "This requirement says retries happen automatically, but it does not define retry count, backoff, or what happens after the final failure. That leaves implementation behavior ambiguous."
}
```

## Example Bad Thread

This would be a bad thread because it is subjective, noisy, and not actionable:

```json
{
  "source": "ai",
  "status": "open",
  "type": "note",
  "severity": "low",
  "anchor": {
    "text": "The service should retry failures automatically."
  },
  "comment": "This sentence could sound a little nicer."
}
```
