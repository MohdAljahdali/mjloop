# S01 — Baseline and safety gate

**Purpose:** Protect existing MjLoop work before feature implementation begins.

**Depends on:** None.  
**May run in parallel with:** Nothing.  
**Code ownership:** None; this story is read-only.

## Inputs

- The repository at `/Volumes/SSD/Projects/loop`.
- The reviewed master plan and review report in the sibling `docs/superpowers/plans/` directory.
- The existing multi-platform migration plan.

## Required work

1. Run `git status --short` before changing any file and record all existing paths as pre-existing work.
2. Read the migration plan's clean-baseline gate and inspect the Milestone 8 state and the known missing-test discovery issue.
3. Run focused config, init, plan-track, and web-boundary tests from `engine`.
4. Record targeted results separately from any full-suite baseline failure.

## Do not do

- Do not stage, revert, reformat, regenerate, or commit pre-existing changes.
- Do not run a destructive cleanup command.
- Do not begin adapter work.

## Completion evidence

- A short baseline record names the dirty paths, test commands, outcomes, and whether S08 is blocked.
- No source or generated file changes exist from this story.

## Stop conditions

- If focused config/init/plan/web tests fail due to a new, unexplained issue, stop. Do not start S02.
- If the migration prerequisite is incomplete, record S08 as blocked; this does not block S02–S07.
