# Mermaid Review Sample

This file is a quick manual smoke test for the review preview.

```mermaid
flowchart TD
  A[Draft PRD] --> B[AI review]
  B --> C{Next action}
  C -->|Apply suggested patch| D[Patch document]
  D --> B
  C -->|Agree reply| E[Keep discussing]
  C -->|Resolve| F[Close as handled]
  C -->|Disagree reply| G[Keep discussing]
  C -->|Reply| B
```

Review target:

- Select this sentence and add a useful text comment.
- Try a too-short comment first to see the handoff quality warning.
- Use the diagram card Feedback button to attach feedback to the Mermaid source.
