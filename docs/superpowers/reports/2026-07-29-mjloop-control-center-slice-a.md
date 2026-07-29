# MjLoop Control Center — Slice A delivery report

## Result

Slice A is implemented on `codex/control-center-slice-a`.

- The active top-level view now has a visible heading, purpose text, strong
  selected treatment, and stable URL routing.
- Plans uses a desktop master-detail layout and a narrow-screen detail view.
  Opening a plan updates `aria-expanded`, keeps the detail in the viewport, and
  moves keyboard focus to its heading.
- Config is editable through a typed conditional write. The editor covers loop
  behavior, limits, gates, verify commands and policy, failure patterns,
  specialist modes, and track definitions.
- `config.yaml` mutations use a content revision, the project lock, whole-file
  schema validation, backup, temporary file, and atomic rename. Comments,
  ordering, and inert legacy keys survive edits outside replaced nodes.
- The browser cannot send an arbitrary YAML path or replacement document.
  Evidence-producing operations remain outside the web write boundary.
- Dense header, status rail, tabs, and editor content remain contained at a
  390-pixel viewport in both directions.

## Root cause fixed in Plans

The Plans route itself was working. The detail singleton was rendered after a
long story list, so pressing **Open** changed content below the current viewport
and appeared unresponsive. The new master-detail layout fixes the location and
publishes the interaction state to keyboard and assistive-technology users.

## Verification

Fresh verification on the final code tree:

```text
npm test
57 test files passed
1119 tests passed

npm run typecheck
exit 0

npm run build
exit 0

npm run verify:ship
14 shipment checks passed
```

The built application was also inspected against the existing `daaei` project
without saving a change:

- plan detail opened with `aria-expanded="true"`;
- focus moved to `plan-detail-title`;
- the detail top remained inside the 720-pixel viewport;
- editing `autonomous` enabled Save and Reset;
- Reset restored the fetched value and disabled both actions;
- Arabic selected `lang="ar"` and `dir="rtl"`;
- at 390 pixels, `body.scrollWidth === body.clientWidth === 390`.

## Product boundary and remaining slices

This delivery intentionally keeps the current single-project runtime. It does
not claim the broader multi-project or multi-platform capabilities designed in
the control-center specification.

The approved first-release runtime rule remains:

- several linked projects may run concurrently;
- exactly one active MjLoop session and one sequential queue per project.

Implementing that rule requires Slice B's user-local project registry and one
`ProjectRuntime` per linked project before Slice C can safely create independent
terminal panels. Claude Code remains the only implemented interactive adapter.
Codex and Gemini stay unavailable until Slice D and the multi-platform adapter
compatibility gates are complete. There is no independent terminal per Claude
subagent in the current engine.

See
`docs/superpowers/specs/2026-07-29-mjloop-control-center-design.md`
for the architecture, safe boundaries, and remaining release gates.
