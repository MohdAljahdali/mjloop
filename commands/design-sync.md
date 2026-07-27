---
description: Extract or refresh the project's design system into .mjloop/design-system.md
---

Produce `.mjloop/design-system.md` by reading what this project's UI actually is.

1. Call `mjloop_state_get`. Report whether a design system already exists — this run will
   replace it.
2. Dispatch the **ui-designer** agent with the extraction brief: establish what platform
   this project renders on, then read its tokens, theme or style configuration, shared
   components, and global styles, and write the design system from them. Do not narrow the
   brief to one platform's markers — a Flutter, Android, or SwiftUI project keeps its
   design system somewhere other than a Tailwind config, and a brief that names only web
   files invites a false `blocked`.
3. Report what it extracted and which files it read. The `sources` list in the
   frontmatter is the claim a reader can check; surface it rather than burying it.

If `ui-designer` returns `blocked` because the project has no UI, say so and stop. An
empty design system is worse than none: every later UI contract would be drawn from it.

Nothing here is generated from a template. A design system describes the product that
exists, or it is misinformation with a confident tone.
