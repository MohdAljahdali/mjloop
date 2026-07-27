---
description: Extract or refresh the project's design system into .loop/design-system.md
---

Produce `.loop/design-system.md` by reading what this project's UI actually is.

1. Call `loop_state_get`. Report whether a design system already exists — this run will
   replace it.
2. Dispatch the **ui-designer** agent with the extraction brief: read the project's
   tokens, theme or Tailwind configuration, shared components, and global styles, and
   write the design system from them.
3. Report what it extracted and which files it read. The `sources` list in the
   frontmatter is the claim a reader can check; surface it rather than burying it.

If `ui-designer` returns `blocked` because the project has no UI, say so and stop. An
empty design system is worse than none: every later UI contract would be drawn from it.

Nothing here is generated from a template. A design system describes the product that
exists, or it is misinformation with a confident tone.
