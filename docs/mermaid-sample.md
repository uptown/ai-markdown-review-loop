# Mermaid Review Sample

This file is a quick manual smoke test for the review preview.

```mermaid
flowchart TD
  A[Draft PRD] --> B[AI review]
  B --> C{User decision}
  C -->|Accept| D[Patch document]
  C -->|Reject| E[Close thread]
  C -->|Reply| B
```

Review target:

- Select this sentence and add normal text feedback.
- Use the diagram card Feedback button to attach feedback to the Mermaid source.
