# Mermaid Review Sample

This file is a quick manual smoke test for the review preview.

```mermaid
flowchart TD
  A[Draft PRD] --> B[AI review]
  B --> C{Next action}
  C -->|Apply edit| D[Patch document]
  D --> B
  C -->|Accept| E[Close as agreed]
  C -->|Resolve| F[Close as handled]
  C -->|Reject| G[Close as declined]
  C -->|Reply| B
```

Review target:

- Select this sentence and add normal text feedback.
- Use the diagram card Feedback button to attach feedback to the Mermaid source.
