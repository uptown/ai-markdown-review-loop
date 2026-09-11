# Migrating From The Old Bootstrap Prompts

Version 0.1 uses one v3 task file and **AI에 전달**. The former bootstrap,
feedback-loop, and per-thread continuation prompts are retired.

Start from the [current review workflow](./AI-COLLABORATION-LOOP.md). The review
JSON already contains brief [agent guidance](./AI-REVIEW-POLICY.md), the target
filename, and the requests for this pass. Give the agent repository context only
when it is needed for those requests.

If an agent conversation still contains the old instructions, tell it to follow
the current v3 task-file guidance. It should edit the source and record done or
blocked results, preserving request IDs and revisions. It should not append
assistant replies, propose close decisions, or wait for the retired patch
approval flow.
