# Support and recovery

Report reproducible problems in the [issue tracker](https://github.com/uptown/ai-markdown-review-loop/issues).
Include the extension version, VS Code version, operating system, whether the
workspace is trusted, and the shortest steps to reproduce.

Use a small synthetic Markdown example. Do not attach private Markdown, review
JSON, VS Code storage folders, credentials or raw user content to public issues.
The extension has no model-provider account, API key, backend or content telemetry.

## Recovery

- **Malformed or conflicting JSON:** inspect the file before changing it. Run
  **AI Markdown Review: Restore Review Backup** to restore the latest valid user
  comments. Confirmation is required; current bytes are backed up first.
- **JSON deleted by the agent:** this is normal. Review the Markdown; your current
  comments remain. Save a comment or copy JSON to prepare another round.
- **JSON and valid recovery both unavailable:** **Start New Review** explicitly
  resets unavailable review state. It refuses to replace recoverable comments.
- **Read-only folder or filesystem error:** restore write access and retry.
  The extension does not report a failed write as a successful save.
- **Restricted Mode:** preview works; trust the workspace before changing or
  copying review data.
- **Ambiguous pasted location:** open the Markdown folder as a workspace and give
  each workspace folder a unique name, or give the agent the sidecar file directly.

## Private recovery storage

Recovery lives below the extension's VS Code workspace storage directory (or
global storage when workspace storage is unavailable), in
`review-recovery/` under a document-specific identifier. This storage can contain
deleted private comment text. Two valid slots protect the current baseline;
other snapshots are capped at four files and 8 MiB per document. Oversized backup
writes fail before the destructive change. The valid slots retain a large
current review even if it exceeds the named-snapshot limit.

**Purge Recovery Data** removes old copies for the selected document after
confirmation, retaining current comments and the latest baseline. It does not
delete Markdown or erase the current review. Never delete an entire VS Code
profile as a recovery step.
