---
description: Cut a release of this plugin — bump the version, tag it, and publish the notes
argument-hint: [major|minor|patch|X.Y.Z]
---

Release this plugin: $ARGUMENTS

**Do the release.** Do not print a checklist for the user to run by hand — they already
asked by running this command. The only outcomes are a published release, or a refusal
naming what blocked it.

`/plugin` decides whether an update exists by comparing the `version` in
`.claude-plugin/plugin.json`. A push that changes behaviour and leaves that number alone
reaches GitHub and stays invisible to every installed copy. This command exists so that
cannot happen quietly.

## 1. Establish that this is a plugin repository

Check for `.claude-plugin/plugin.json`. If it is missing, **refuse and stop**: say this
command releases a Claude Code plugin and this project is not one. Do not improvise a
release out of a `package.json` alone — a plugin's installed version comes from the
manifest, and nothing else.

## 2. Refuse to release a repository that is not ready

Stop on any of these, and say which one:

- **A dirty working tree.** Uncommitted work either belongs in the release or does not;
  guessing which is not yours to do. Show `git status --short` and let the user decide.
- **A branch behind its remote.** `git fetch` first. Releasing from behind drops whatever
  landed in between out of the tag.
- **Verification that does not pass.** Run the project's build and test commands and read
  the output. A release is the one artifact that reaches users without a review in front
  of it. If a command does not exist, say which one you looked for rather than treating
  its absence as a pass.

## 3. Choose the version

Read the current version from the manifest, and the commits since the last tag
(`git describe --tags --abbrev=0`, then `git log <tag>..HEAD --oneline`; with no tags yet,
the whole history).

If the argument names a level or an explicit `X.Y.Z`, use it. Otherwise derive it from
those commits:

| Present in the range                     | Bump  |
| ---------------------------------------- | ----- |
| A breaking change (`!` or BREAKING CHANGE) | major |
| A `feat`                                  | minor |
| Anything else                             | patch |

State which you chose and the commit that decided it. If the range is empty, **refuse**:
there is nothing to release.

Below `1.0.0`, a breaking change bumps the minor — `0.x` carries no compatibility promise,
and burning the major on it costs the version that will mean something later.

## 4. Bump every file that carries the version

The manifest is the one that matters, but a repository whose `package.json` disagrees with
it will confuse the next reader and trip the `pre-push` hook. Find them all — grep for the
current version string rather than assuming the pair — and set them together.

## 5. Commit, tag, and push

1. Commit with the message `chore: release <version>`, and a body saying what the release
   contains rather than restating the number.
2. Tag it annotated: `git tag -a v<version> -m "<plugin name> <version>"`. A lightweight
   tag carries no date or author, and a release is exactly the object worth having those on.
3. Push the branch, then the tag.

## 6. Publish the notes

Create the GitHub release with `gh release create v<version> --title "v<version>"`.

Write the notes from what the commits changed, grouped under headings a user recognises —
not a list of commit subjects. For each group say what was wrong before and what is true
now; a reader deciding whether to update is asking what breaks if they do not. Mention any
step the update requires of them, and say plainly when there is none.

If `gh` is not authenticated, the tag is already pushed — say so, give the release URL,
and stop rather than leaving the user unsure how far it got.

## 7. Report

Give the release URL, the version, and what verification you ran. If you skipped a check
in step 2 because the command did not exist, say that here too — an unrun test is not a
passing one.
