# Using the Review JSON

The review JSON is the only handoff context. It contains the Markdown filename,
short [agent guidance](./AI-REVIEW-POLICY.md), and the current user comments for
this pass.

Give a file-capable agent the sidecar path, or use **Copy Review JSON** when the
agent needs pasted input. The agent should read the current Markdown, verify
targets, edit the source, preserve the comments, record a short result, and
delete the JSON after the round. No bootstrap prompt or in-extension
conversation is required.
