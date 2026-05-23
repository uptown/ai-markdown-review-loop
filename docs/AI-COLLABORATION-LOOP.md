# AI Collaboration Loop

This document defines how humans and AI agents should collaborate inside AI
Markdown Review Loop. The goal is to make review threads a durable negotiation
surface instead of a one-shot comment dump.

## Roles

The human owns:

- product intent
- domain constraints
- objections and clarification
- final decisions such as `accepted`, `resolved`, or `rejected`

The AI owns:

- identifying document issues
- proposing localized fixes
- asking clarifying questions when context is missing
- drafting follow-up replies that move a thread forward

## Core Principle

The thread is the loop.

AI should not behave like a batch linter that comments once and disappears.
Humans should not have to restate the entire project every time they reply.
Each thread should accumulate context, objections, edits, and decisions until it
is safe for a human to close.

## Recommended Loop

1. Bootstrap context from repo docs and the initial human packet.
2. AI creates or replies to open review threads.
3. Human replies, edits the Markdown, or leaves a decision.
4. AI revisits only the affected threads and either:
   - proposes a localized edit
   - asks a sharper follow-up question
   - acknowledges the new context and stands down
5. Human makes the closure decision or leaves the thread open for another pass.

## When AI Should Reply Instead Of Opening A New Thread

AI should reply to an existing thread when:

- the human reply changes the interpretation of the same issue
- the same anchor text and same action are still in play
- the AI wants to refine, narrow, or retract prior feedback
- the human asks for a concrete patch or restatement inside that thread

AI should open a new thread only when the concern is materially separate and
would need an independent decision.

## Closure Rules

AI may suggest what it thinks the right resolution is, but it should not close a
thread on its own unless the user explicitly requests a closure action.

## Good Human Input

The most valuable human replies are:

- why the current text exists
- what constraint the AI missed
- whether the issue is real but deferred
- what kind of patch is acceptable
- whether a thread should stay open, split, or be rejected

## Good AI Follow-Up

The most valuable AI follow-up replies are:

- acknowledgement of changed context
- a narrower diagnosis
- a safer suggested patch
- a crisp clarification question
- explicit recognition that the earlier concern is no longer valid
