# AI Context Bootstrap

This document explains how a person installing AI Markdown Review Loop should
give an AI enough context to produce useful review comments on the first pass.

## Problem

Without context, AI review quickly drifts into shallow style feedback or makes
bad assumptions about what matters.

The plugin cannot safely infer product intent, domain constraints, or business
rules from Markdown alone. That context needs an explicit home.

## Prompt First, Brief Second

The first user-facing step should not be "fill out a blank context file."

The first step should be a bootstrap prompt that tells the AI to:

1. read the repo-owned docs that already exist
2. ask only for the missing context
3. draft a durable `docs/AI-CONTEXT-BRIEF.md`

That keeps onboarding lightweight for the human while still giving the repo a
stable context artifact for later review passes.

## Recommended Plugin UX

When the repo does not yet have `docs/AI-CONTEXT-BRIEF.md`, the plugin should:

1. keep a compact `AI Context` status bar visible in the review preview
2. show `Open Bootstrap Prompt` as the primary action when no saved brief exists
3. switch that same control to `Refresh Bootstrap Prompt` after a brief exists
4. show `Create Brief` before the file exists, then `Open Brief` after it exists
5. keep the actual `docs/AI-CONTEXT-BRIEF.md` file as the durable output, not
   the first thing the user has to author by hand

## Recommended Context Sources

Before the first AI review pass, the bootstrap prompt should tell the AI to
read these sources in order when they exist:

1. `docs/AI-CONTEXT-BRIEF.md`
2. `docs/PRD.md`
3. `.agent/PROJECT_STATE.md`
4. `README.md`
5. the current Markdown document under review

If the early files already answer the core questions, the AI can draft or
refresh the brief immediately. If not, it should ask for the missing context
instead of guessing.

## Minimum Context Packet

For a strong first review pass, the human should provide:

- product goal
- intended audience
- hard constraints
- non-goals
- canonical source docs
- current open decisions
- review focus for this pass

## Durable File Convention

For teams that want repeatable AI review quality, create a repo-owned file at:

- `docs/AI-CONTEXT-BRIEF.md`

This file should be short and durable. It is not meant to duplicate the entire
PRD. It should capture the context that the AI must know before it comments.

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

- not start the real review yet
- read the repo sources in order
- extract whatever context is already knowable
- ask at most 3 specific follow-up questions about missing context
- draft or refresh `docs/AI-CONTEXT-BRIEF.md` in the exact template above
- stop after drafting the brief so the human can confirm or save it

## How The Plugin Should Use This

The export packet for AI agents should:

- point to this bootstrap convention
- tell the AI which files to read first
- tell the AI what to ask the human if the repo is missing context
- point users toward the bootstrap prompt instead of asking them to fill a
  generic brief from scratch

That way the first AI review pass starts from explicit context instead of
default model assumptions.
