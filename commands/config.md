---
description: Read or change this project's loop orchestration settings
argument-hint: [get | set <key> <value>]
---

Read or change the loop's orchestration settings for this project: $ARGUMENTS

Everything below goes through `mjloop-cli config`. Run it with the plugin's own engine:

```bash
CLI="node ${CLAUDE_PLUGIN_ROOT}/engine/dist/cli/index.js"
$CLI config get
$CLI config set <key> <value>
```

Both accept `--dir <path>` when the project is not the working directory, and `config get`
accepts `--json`.

## Do not hand-edit `.mjloop/config.yaml`

**Editing the file with `Edit` or `Write` is not the path, and this is not a style
preference.** The guarded write behind `config set` does three things an editor cannot:

1. It **compare-and-swaps on the file's sha256 revision**, so a change built on bytes that
   have since moved is refused instead of quietly clobbering whoever wrote in between.
2. It **re-parses the whole document** after applying the change. A setting can be
   perfectly legal on its own and illegal beside another —
   `discovery.completion: auto-plan` with `discovery.mode: off` names a start that can
   never happen — and only a whole-document parse sees it.
3. It **writes nothing at all when either check fails**, so a refusal leaves the file
   byte-identical rather than half-applied.

A hand edit gets none of the three. Its damage also does not surface at the keystroke: the
config is next loaded when somebody starts a run, so a broken document turns up as a failed
`/mjloop:build`, in a different session, with no obvious cause.

## Reading

`config get` prints every orchestration setting and the revision the file is currently at.
Report the settings the user asked about. If the command exits non-zero, the config is
missing or no longer parses — say which, quote the message, and stop. Do **not** describe
the defaults as though they were in force: a config that does not parse means every op that
loads it is failing right now.

## Changing

Each `config set` changes exactly one setting. The keys, and what each accepts:

| key | value |
|---|---|
| `orchestration.profile.auto_accept` | `true` / `false` |
| `orchestration.discovery.mode` | `always` / `ask` / `off` |
| `orchestration.discovery.question_budget` | whole number, 1–20 |
| `orchestration.discovery.completion` | `auto-plan` / `review` / `save-only` |
| `orchestration.execution.after_plan_approval` | `auto` / `manual` |
| `orchestration.execution.uncertain_concurrency` | `sequential` / `ask` / `parallel` |
| `orchestration.execution.repair_attempts` | whole number, 0–5 |
| `orchestration.quality.mode` | `economy` / `adaptive` / `strict` |
| `orchestration.skills.sources` | comma-separated subset of `github,registry,web` |
| `orchestration.skills.trusted_registries` | comma-separated `https://` URLs |
| `orchestration.skills.update_mode` | `auto` / `review` / `pinned` |

A comma-separated key takes the **empty string** for the empty list —
`config set orchestration.skills.sources ''` is how a project says no skill may be
discovered from outside it at all. That is a real setting, not a way of clearing one.

On a non-zero exit, read the message and report it as it stands. There are four kinds and
they call for different next steps:

- **`is not a setting`** — the key does not exist. The message lists the ones that do; pick
  from it rather than guessing a spelling.
- **`does not accept`** — the value is outside the bounds the schema states. Nothing was
  written.
- **`would make ... invalid`** — the value is legal on its own and contradicts another
  setting. Name both settings to the user and ask which one they meant to change; do not
  "fix" the other one on your own initiative, because that is a second decision they did
  not make.
- **`changed after this command read it`** — somebody else wrote the file in between.
  Run `config get`, show the user what the setting is now, and only then re-run the change
  if they still want it. Never retry automatically: that applies their change on top of an
  edit nobody has looked at.

## What this command does not cover

`config set` reaches the `orchestration` block and nothing else. `tracks`, `verify`,
`gates`, `specialists` and `limits` are not settable here — change those in the cockpit
(`/mjloop:web`), which goes through the same guarded write, and afterwards call
`mjloop_state_get` and check that `config_error` is null.

It also cannot accept a project profile revision. `orchestration.profile.auto_accept` only
decides whether a scan may activate a component map on a project that has none; a map that
is already accepted is immutable and is never replaced by a setting.

Accepting one is a separate decision with its own commands, on the same binary:

```bash
$CLI profile show                    the accepted revision, the current proposal, and whether they differ
$CLI profile accept [--expect <revision|none>] [--from <revision>]
                                     accept the proposal as the next immutable revision, or with
                                     --from reselect an earlier accepted revision's map instead
$CLI profile reject                  discard the proposal, leaving the accepted revision active
```

Run `profile show` and report what it says before running either of the other two —
accepting a component map activates routing for every later run, so it is the user's
decision to make and not yours. Pass `--expect` with the revision `show` printed (or the
word `none` when it printed none): the acceptance is then refused rather than obeyed if
somebody else accepted a map in between. `--from` is how a rollback is done, and it is the
user's decision on the same terms: it ignores the proposal entirely, reads the named
revision's components, and accepts them as a *new* revision superseding whatever was
current — nothing earlier is rewritten, and no pointer moves. Never edit anything under
`.mjloop/profile/` — the `PreToolUse` guard denies it, because an accepted revision is
immutable and a hand-edited proposal is a component map nobody scanned.
