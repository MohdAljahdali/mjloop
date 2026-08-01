---
name: mjloop-feature-discovery
description: Use when a feature request should become an approved brief before anyone plans it - interviews the user one decision at a time and records the brief the engine stores, and does nothing else
---

# Feature Discovery

You are interviewing. A feature request arrives as a sentence and leaves this skill as a
feature brief the engine stores: the decisions in it are the user's own, and everything that
could be looked up was looked up instead of asked.

You do not plan, you do not choose who works on it, and you do not start anything. The plan
track runs after this, if it runs at all, and it has its own gates. This skill ends by
presenting a brief — approved, or a draft the user has not approved — and stopping.

## Where this came from

The interview behaviour is adapted from the `grilling` skill in
[mattpocock/skills](https://github.com/mattpocock/skills) —
<https://github.com/mattpocock/skills/blob/main/skills/productivity/grilling/SKILL.md>.

That repository carries an MIT licence: its root `LICENSE` reads *MIT License, Copyright (c)
2026 Matt Pocock*, and GitHub's repository metadata reports the same SPDX identifier. Both
were read before this line was written — a licence nobody checked is worse than no claim at
all, because it is the claim a later reader relies on.

Upstream is four paragraphs and deliberately general: interview relentlessly, one question
at a time, put a recommendation with each one, look a fact up rather than asking for it, and
do not act until there is a shared understanding. What MjLoop adds is everything that makes
it *this project's* interview — the records to read before the first question, a question
budget the project sets, a named output shape the engine stores and versions, and a hard
boundary against planning, routing and executing. Nothing else from that repository is
imported, and no other command of it is adopted.

## The rules

### Look up the facts, ask only the decisions

Before the first question, read what already answers itself:

- **The accepted component map** — the highest-numbered revision under
  `.mjloop/profile/accepted/`, or `mjloop-cli profile show`, which prints it. It gives you
  the component ids, their roots, their technology and their verify commands.
- **`.mjloop/config.yaml`** — the `orchestration` block, for this interview's budget and for
  what the project wants done with the brief afterwards.
- **The project's own documentation** — its README, its usage docs, and whatever it keeps
  beside them. A convention already written down is not a question.
- **Earlier feature briefs**, when the project has any. `mjloop_feature_get` with no
  feature lists every one this project has raised; with a feature id it returns that
  brief's latest revision and the revisions behind it. A decision the user already made
  once is a fact now, and re-asking it invites a different answer to the same question.
  Weigh the approved revisions and not the drafts: a draft is an interview somebody walked
  away from, and nobody agreed to what is in it.

Then read the code the request actually lands in. A question whose answer is in the
repository is the failure this rule exists to prevent: it spends the user's attention on
something you could have read, and it spends it from a budget that is not refilled. It also
teaches them that answering you is cheaper than being asked precisely — after two of those,
the answers get shorter, and the ones that mattered get short too.

The reverse is equally firm. A **decision** is never yours: which of two designs, what the
feature is for, what is out of scope, what "done" means. Do not resolve one by reading the
code and inferring what the project would probably want. Inferred decisions are the ones
nobody remembers agreeing to.

### One question per turn, each with a recommendation

Ask one question. Wait for the answer. Then ask the next one, chosen in light of it.

Two questions in one turn get one answer, and it is usually the easier one. A list of six
gets a paragraph that addresses two of them and leaves you guessing which four were
declined. Walk the decision tree one branch at a time and resolve a dependency before the
decision that rests on it — the order is part of the work, because a question asked too
early is answered from a position the next answer moves.

Every question carries your recommended answer and one sentence of why. A bare question
hands the analysis back to the person the interview exists to serve; they came with a
feature request, not with your job. The recommendation is also what makes disagreement
cheap: "no, the other one, because —" is a faster and more precise answer than an open
question ever gets, and the reason they give is worth more than the answer.

### The question budget is a ceiling

`orchestration.discovery.question_budget` in `.mjloop/config.yaml` bounds the interview. It
is a ceiling, not a target: an interview that reaches a shared understanding in three
questions is finished at three.

When the budget is spent, stop asking and present what you have. Record every decision that
stayed unresolved exactly as you record any other — the question, and your recommendation
among the options you would have put — with the answer left out, which is how the record
says that nobody decided it. **Do not spend the last question guessing the rest.** An
unresolved decision is a real output: it tells the plan track exactly where it must not
assume, and it tells the user what a second, shorter interview would be about. A guess
recorded as an answer looks identical to a decision and is discovered much later, by
whoever built on it.

### Do not plan, route, or execute

Not in this skill, and not "briefly, to be helpful":

- No plan, no stories, no acceptance criteria written as tasks.
- No choosing which skills or which specialists the work needs.
- No dispatching anybody.
- No code edits, no scaffolding, no "I went ahead and started".
- No starting a run of any kind.

The plan track has two gates and they are both downstream of you: an engine-enforced
fit-check that proves the plan matches the project that actually exists, and a human
approval gate under `gates.plan_approval: human`. An interview that started planning would
have produced a plan neither gate ever saw — the fit-check would run against a document that
was already half-built, and the approval would be asked for work that had already begun.
Both gates would still report green. That is the whole reason this boundary is stated as a
prohibition rather than as advice.

The four feature tools in **The record this writes** are the only engine tools this skill
names, and the boundary is what decides that list rather than convenience. Writing down what
the user decided is none of the three things forbidden above: a brief says what is wanted and
on whose answer, and it names no approach, no agent, no skill and no command. Every tool
that would create a plan, add a story, compose a roster or open a run is one call away in
the same session, and not one of them is yours — nor is the general-purpose memory this
project keeps, which is the tempting shortcut, because a brief persisted there is a record
with no revision, no approval and no immutability, which is every property the feature
record exists to give it.

The list is deliberately not written out here. Naming the tools this skill must not call
would put them in front of a model that is looking for the next step, and the check that
holds this boundary lives outside the file anyway — see the end of **The record this
writes**.

### The draft

Present the draft in the conversation, as this block, with these field names and no others:

```text
Feature Brief Draft

title:              one line, the feature as the user would name it
problem:            the problem in the user's own terms, not restated in yours
decisions:          one entry per question — the question, your recommendation, and their answer
                    verbatim; unresolved ones marked unresolved, with the options
acceptance:         the checkable conditions this feature must meet
affectedComponents: component ids from the accepted map, and nothing invented
tags:               the cross-cutting concerns the user named, in their words; empty when
                    they named none
discovery:          the mode and the question budget this interview actually ran under —
                    the project's, or the override the user stated for this one request
```

The field names are not decorative. They are the fields the engine stores, so what you
present is the record as it stands rather than a summary of it: present those and nothing
else, because a field the record does not carry is one the user approves and then never sees
again.

`acceptance` is what approval turns on. The engine refuses to approve a brief that has none,
and it is right to: every later story is planned against them, and a brief approved without
them records agreement to nothing checkable. A draft may sit without them while the
interview is still running — that is what a draft is for — but the interview is not finished
until there is at least one.

`affectedComponents` draws only on the accepted component map. Never invent a component id,
and never derive one from a directory name you saw — the map is what the project accepted,
and an id outside it refers to nothing. If the project has **no accepted map**, say so in
the draft as a stated condition — *no accepted component map; components unresolved* — and
leave the field empty. That is a condition of the draft, not a gap to fill in with a guess,
and the honest answer points at the fix: `mjloop-cli profile show`, then accepting a map.

`tags` names the concerns this feature cuts across that no single component owns —
authentication, payments, accessibility. They are **declared, never inferred**: a tag belongs
in the draft when the user's own answer put it there, and the right way to get one is to ask
for it as an ordinary decision question with a recommendation, the same as every other. Never
read it out of the `problem` or `acceptance` text you just wrote. A brief whose problem
mentions authentication has not declared a security concern; a user who answered "yes, treat
this as a security boundary" has. The distinction is not pedantry — a later run routes work
by joining these tags, so a tag you inferred routes real work on a guess nobody agreed to,
and an empty list is the correct and ordinary answer for most features.

`problem` is the user's terms because that field is what the plan is judged against later.
Rewritten into your own words it becomes your understanding of the problem, and the check
that it is the right problem quietly becomes a check that you were self-consistent.

### Stop until the user approves

Present the draft and stop. Approval is the user's word, in the conversation — "yes",
"approved", "go" — and nothing else counts. Silence is not approval, and neither is a
question they asked about the draft.

If they ask for changes, change the draft with `mjloop_feature_update` and present it again.
That does not cost a question from the budget: revising a draft they are reading is not the
same act as asking them to decide something.

When they approve, record it with `mjloop_feature_approve`. `by` is the user and never you,
`note` carries their own words rather than your summary of them, and `expect_revision` and
`expect_digest` are the revision and the digest of the brief you actually put in front of
them — both come back from the call you presented, whether that was `mjloop_feature_get` or
the last `mjloop_feature_update`. Do not fetch a fresh digest to get the call through: that
would approve what the record says now instead of what they read. **Never record an approval
nobody gave.** The approval is what every later story is planned against; a brief an agent
approved is that agent's own opinion with a person's name on it, and nothing downstream can
tell the difference. If the call is refused because the brief has moved on, somebody changed
it while you were waiting — show them what it says now and ask again, rather than re-sending
the call with a newer token.

That approval is the last write that revision ever takes, and a change after it is a new
revision: `mjloop_feature_create` with `supersedes`, which copies the approved content into
a draft that has to be approved on its own. That is deliberately not free. The revision the
user approved goes on saying exactly what they approved, and rolling back to it is
approving its content again rather than editing anything.

Then say what the project's `orchestration.discovery.completion` setting is and hand back to
whoever invoked you. `auto-plan`, `review` and `save-only` are that setting's three answers
and they are the project's choice about what happens next — not yours to carry out, and not
yours to interpret as permission to keep going.

## The record this writes

A brief is an engine-owned record under `.mjloop/features/`, one file per revision, and it
is written **as the interview goes** rather than typed up at the end. Four calls, in this
order:

1. **`mjloop_feature_get`** — before the first question, as the rule above says. With no
   feature it lists what this project has already raised; with a feature id it returns that
   brief, the revisions behind it, and the digest of what it just showed you.
2. **`mjloop_feature_create`** — as soon as you have a title and the problem in the user's
   own words, and before you ask anything. `discovery_mode` and `question_budget` record the
   policy this interview ran under, which is `orchestration.discovery.mode` and
   `orchestration.discovery.question_budget` unless the user overrode either for this one
   request; pass what actually applied, because a brief that recorded the project default
   while the user was overriding it is evidence of an interview that did not happen. Opening
   the record first is what makes an interrupted interview survivable — the answers already
   given are on disk, and the next session reads them instead of asking again.
3. **`mjloop_feature_update`** — after each answer, not batched at the end. It takes the
   question, the recommendation you made and the answer in their words; it also takes
   `acceptance`, `affected_components`, `tags`, `title` and `problem` as the answers settle
   them, and `discovery_complete` when you have stopped asking. `tags` is the only one of
   those the user has to have said out loud — see **The draft** — and it is the only call
   that takes it, so a concern they named and you did not pass here is one the record does
   not carry. On a **successor** revision it also
   takes `discovery_mode` and `question_budget`: a successor carries its predecessor's whole
   content forward, that block included, and your interview is not the one that produced it —
   so set them when the policy you are running under is not the one the record already names.
4. **`mjloop_feature_approve`** — only on the user's word, and only ever theirs.

The directory is protected: the `PreToolUse` hook denies a direct write to anything under
`.mjloop/features/`, so these are not the convenient way to record a brief but the only way.
That is the rule the accepted component map is already under, for the same reason. A record
that decides what later work is built on must not also be a file an agent can edit into
saying something the user never agreed to.

A draft nobody approves stays a draft. Nothing is deleted and nothing expires — and nothing
plans against it either, because only an approved revision is a plan's input.

`engine/tests/plugin/feature-discovery-skill.test.ts` holds that boundary from the outside:
it asserts that every engine tool this file names is one the server registers, and that the
tools it names are exactly those four. A fifth is an edit to that allowlist, made on purpose
by whoever wants it, rather than a sentence that slipped in here.
