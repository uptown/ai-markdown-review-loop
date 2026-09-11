# AI Markdown Review Loop

Turn comments on Markdown into a short task file for your coding agent.
Select what needs changing, describe the change, send the review file to an
agent that can edit your workspace, then review the revised document.

Built for specs, PRDs, implementation plans, READMEs, and ADRs.

![Comment, hand off, and review the revised Markdown](./media/marketplace-hero.png)

![Illustrated four-step workflow](./media/review-loop-demo.gif)

[Download the illustrated MP4 walkthrough](./media/review-loop-demo.mp4)

The images illustrate the workflow; they are not screenshots of a live agent run.

## Get Started

1. Open a Markdown file and choose **AI Markdown Review: Open Review Beside**.
2. Select rendered text and save a comment describing the change you want.
3. Choose **AI에 전달** (Send to Agent) and paste the copied request into your coding agent.
4. Let the agent edit the Markdown and record a short **done** or **blocked** result.
5. Once the agent has stopped writing, choose **수정본 검수** (Review changes) and inspect the
   revised document. Reopen an item or add a new comment for another pass.

The extension runs locally and does not call a model provider. Use an external
agent with permission to read and edit your workspace. A chat that cannot access
your files needs the source supplied separately and cannot update them through
this extension.

## One Small Review File

For each Markdown document, review requests live in one hidden JSON file beside it:

```text
docs/spec.md
docs/.spec.md.ai-review.json
```

The v3 file contains the document filename, brief agent guidance, and items with
an ID, revision, target quote, comment, and status. It does not embed the full
Markdown document or a conversation transcript.

| Status | Meaning | Next action |
| --- | --- | --- |
| 미처리 · Pending | This request still needs work. | Send it to the agent. |
| 처리 완료 · Done | The agent reports that this revision is handled. | Review the actual Markdown; reopen if needed. |
| 확인 필요 · Blocked | The agent could not fully handle the request. | Read the reason, clarify with the agent or edit the request. |

A result belongs to the revision in `resultFor`. An externally returned result for an older revision is shown as stale and
does not complete the current request. Editing a request or its target starts
a new revision. **Done is an agent report, not a guarantee that the edit is correct.**

See the [agent contract and JSON schema](./docs/AI-REVIEW-POLICY.md).

## Handoff And Recovery

**AI에 전달** saves the current files, checkpoints the requests, and copies a
short request identifying the review file. During handoff the extension pauses
review and source writes so the agent can work. This pause survives a preview or
VS Code reload. You can keep reading and drafting comments; drafts are not saved
requests until you return to review mode and save them.

**수정본 검수** validates the returned file and its request identities before
resuming writes. Wait until the agent stops writing first. Missing items, changed
requests, invalid JSON, and interrupted writes require recovery; they are not
silently treated as completion. Canceling a handoff resumes review after the same
checks and does not undo the agent's Markdown changes.

**내용 복사** uses the same handoff boundary. **리뷰 파일 확인** opens a
read-only view for inspection without starting a handoff. You
can also give the colocated file path to an agent directly, but this bypasses the
extension's pause, checkpoint, and automatic history cleanup. In that case, keep
the extension and agent from writing at the same time. The supported workflow
has one writer; it does not lock arbitrary external programs or coordinate
multiple VS Code windows.

Completed items from a prior round are saved in local history before the next
handoff removes them from the active JSON. Pending and blocked work remains.
History can be inspected and reopened without sending it on every round.

Unsaved comments and edit drafts survive preview refreshes in local VS Code
webview state. Failed saves keep the draft for retry. When source has changed,
copy the recovered draft and apply it to the current content after checking the
target. Draft recovery is not a backup across uninstall or cleared app data.

## Review The Whole Document

- Comment on rendered text, local images, tables, Mermaid diagrams, and code.
- Use **Previous**, **Next**, and **Show in document** to navigate feedback.
- Use **Reattach** to confirm a new target for a missing or incorrect location.
  Ambiguous selections require a more specific quote.
- Open source and preview side by side, or use the preview's block, table, and
  Mermaid editors for small manual edits while review mode is active.
- Local images render in the preview. Remote images use a reviewable placeholder
  and an external link instead of loading automatically.

Line numbers are hints. The agent must check the current quote and context;
missing or ambiguous targets stay blocked until they can be identified safely.

## Commands And Shortcuts

- **AI Markdown Review: Open Review Beside** — source and preview side by side.
- **AI Markdown Review: Open Review Preview** — rendered review only.
- `Cmd+Alt+Shift+R` on macOS / `Ctrl+Alt+Shift+R` elsewhere — open beside.
- `Cmd+Alt+R` on macOS / `Ctrl+Alt+R` elsewhere — open preview.

Handoff, results, and recovery actions are in the preview. Version 0.1 replaces
the earlier reply threads, local checks, suggested-patch approval, and separate
bootstrap/export prompts with this single task-file workflow.

## Existing Reviews

Older v2 reviews require conversion before handoff. The extension backs up the
original review data. Existing open requests keep their IDs and targets;
labeled discussion and suggested-patch context is folded into the converted
request so the agent can inspect it. Conversion does not mark that work done. Old accepted, resolved, and
rejected items remain legacy history, distinct from the agent's v3 done results.
Keep the backup if you need to inspect old conversations or return to an older
extension version. See [migration and recovery](./docs/REVIEW-WORKFLOW.md).

## Privacy

Review JSON lives in your workspace; handoff checkpoints, archives, and drafts
are stored locally. The extension does not send document text to an AI provider.
You choose the external agent and what it can access. Review comments and results
may contain sensitive project context, so check both Markdown and sidecar files
before sharing or committing them.

## License And Support

MIT licensed. See the [license policy](./docs/LICENSE-POLICY.md) and
[third-party notices](./THIRD_PARTY_NOTICES.md).

[Report an issue](https://github.com/uptown/ai-markdown-review-loop/issues).
