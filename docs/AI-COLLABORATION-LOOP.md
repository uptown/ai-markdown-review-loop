# Comment → JSON → Agent Edit → Review

The user creates, edits and deletes comments. The external agent changes the
Markdown. The [task contract](./AI-REVIEW-POLICY.md) is authoritative.

1. Select text in the review preview and save a comment.
2. Give the agent the sidecar path, or use **Copy Review JSON** for pasted input.
3. The agent reads the current Markdown and every current comment. It leaves
   already-satisfied requests unchanged and asks about ambiguous targets.
4. It saves Markdown changes and deletes the JSON.
5. Review the actual Markdown. Manage your comments and prepare the next pass
   by saving a comment or copying JSON.

A missing JSON ends a round but does not clear current comments. Restarting
VS Code restores the last valid comments if recovery storage is available.
A fast write followed by deletion cannot deliver a reliable result to a closed
editor; therefore this workflow does not display or depend on agent results.

There are no replies, completion statuses, history/reopen actions or write locks.
Avoid simultaneous source edits. If JSON conflicts with newer user comments,
use **Restore Review Backup** after inspecting the error. If no valid data can
be recovered, **Start New Review** offers an explicit empty restart.
