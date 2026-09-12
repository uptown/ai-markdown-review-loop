# Using the Review JSON

The JSON carries the current user comments and [agent guidance](./AI-REVIEW-POLICY.md).
Give a file-capable agent its sidecar path, or use **Copy Review JSON** for
compact pasted input with a workspace-relative document location.

The agent reads the current Markdown, reviews every comment, preserves
user-owned fields, saves changes and deletes the JSON. Already-satisfied requests
need no source change. If the destination or quote is ambiguous, ask the user.

Review the Markdown itself, then edit, delete or add comments for the next pass.
No extra bootstrap prompt, in-extension conversation or agent-result delivery
is needed.
