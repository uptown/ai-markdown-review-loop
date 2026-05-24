# AI Context Bootstrap

This document explains how a person installing AI Markdown Review Loop should
give an AI enough context to produce useful review comments on the first pass.

## Problem

Without context, AI review quickly drifts into shallow style feedback or makes
bad assumptions about what matters.

The plugin cannot safely infer product intent, domain constraints, or business
rules from Markdown alone. That context needs an explicit home.

## Prompt First, Brief Optional

The first user-facing step should not be "fill out a blank context file."

The first step should be a bootstrap prompt that tells the AI to:

1. read the repo-owned docs that already exist
2. ask only for the missing context
3. capture the human's current review session brief
4. treat review threads as conversation state
5. preserve nearby review state while editing Markdown
6. report every touched review thread outcome

That keeps onboarding lightweight for the human while still giving the repo a
stable agent contract for review and edit passes.

## Recommended Plugin UX

The review preview should expose one compact action:

- `Open Bootstrap Prompt`

The preview should not show context readiness, detected brief status, `Open
Brief`, or `How it works` as top-of-document chrome. The generated prompt is
the handoff surface and should be copy-pasteable as-is. It should not wrap the
actual prompt in a detected-source report, explanatory preface, or Markdown code
fence. It can mention `docs/AI-CONTEXT-BRIEF.md` as an optional durable context
artifact, but the UI should not force the human into managing that file before
review work can start. It should not embed the context brief template or
sidecar schema internals in the generated prompt.

After the first bootstrap, active review iteration should use a separate
`Open Feedback Loop Prompt`. That prompt is for continuing existing Review
Threads, drafting replies, and applying explicit suggested patches while
preserving review metadata.

## Context Discovery

Before the first AI review pass, the bootstrap prompt should tell the AI to
start from the current Markdown target, then read shared repo context that is
available to an AI agent. Useful shared sources often include:

- `README.md`
- `docs/AI-CONTEXT-BRIEF.md`
- `docs/AI-REVIEW-POLICY.md`
- `docs/AI-COLLABORATION-LOOP.md`
- `docs/agent-review-thread.schema.json`
- nearby docs that explain the same feature, workflow, or product area

If the available context already answers the core questions, the AI can
continue with the requested review or edit task. If not, it should ask for
missing context instead of guessing. When the missing answer belongs to the
document under review and review tools are available, the AI should create or
reply to a focused `question` thread instead of stopping the loop in chat.

## Minimum Context Packet

For a strong first review pass, the human should provide:

- product goal
- intended audience
- hard constraints
- non-goals
- canonical source docs
- current open decisions
- review focus for this pass

For an active review loop, the AI should also recover the review session brief
from the latest human request and thread replies:

- review goal for this pass
- focus areas
- non-goals
- hard constraints
- preferred comment style
- done condition

## Durable File Convention

For teams that want repeatable AI review quality, the AI may create or refresh
a repo-owned file at:

- `docs/AI-CONTEXT-BRIEF.md`

This file should be short and durable. It is not meant to duplicate the entire
PRD, and it is not a prerequisite for every review pass. It should capture the
context that the AI must know before it comments.

## Context Brief Template

```md
# AI Context Brief

- Product goal:
- Intended audience:
- Hard constraints:
- Non-goals:
- Canonical source docs:
- Current open decisions:
- Review focus for this pass:
```

## What The Bootstrap Prompt Should Tell The AI

The generated bootstrap prompt should tell the AI to:

- treat the whole opened document as the prompt to follow
- work in any AI agent that can read/edit repo files
- use the Markdown target named by the human or current conversation, asking
  which Markdown file to review or edit only when it is unclear
- stay generic and avoid embedding a generated target line inside the reusable
  prompt body
- capture or recover the review session brief from the human request and recent
  thread replies
- ask at most 3 specific follow-up questions about missing context, using a
  focused `question` thread when the question belongs to the document
- treat Review Threads as conversation state rather than disposable comments
- preserve nearby `.<filename>.ai-review.json` sidecars and inline
  `ai-review-*` metadata comments during normal Markdown edits
- prefer localized edits over whole-document rewrites
- apply suggested Markdown changes only when the human explicitly asks
- report every touched `rv_*` thread with an outcome

## How The Plugin Should Use This

The export packet for AI agents should:

- point to this bootstrap convention
- tell the AI which files to read first
- tell the AI what to ask the human if the repo is missing context, and when
  that question should become a review thread
- point users toward the bootstrap prompt instead of showing a persistent
  context status panel in the review preview
- reinforce that Markdown edits must preserve review metadata and report
  affected thread outcomes

That way the first AI review pass starts from explicit context instead of
default model assumptions.
