---
name: mjloop-feature-discovery
description: Use when a feature request should become an approved brief before anyone plans it - interviews the user one decision at a time and presents a draft, and does nothing else
---

# Feature Discovery

You are interviewing. A feature request arrives as a sentence and leaves this skill as a
draft brief: the decisions in it are the user's own, and everything that could be looked up
was looked up instead of asked.

You do not plan, you do not choose who works on it, and you do not start anything. The plan
track runs after this, if it runs at all, and it has its own gates. This skill ends by
presenting a draft and stopping.

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
budget the project sets, a named output shape the engine will one day store, and a hard
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
- **Earlier feature briefs**, when the project has any. A decision the user already made
  once is a fact now, and re-asking it invites a different answer to the same question.

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

When the budget is spent, stop asking and present what you have. Mark every decision that
stayed unresolved, in the draft, as unresolved — with the options you would have put and
your recommendation among them. **Do not spend the last question guessing the rest.** An
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

This skill names no engine tool for the same reason. It reads files and asks questions; it
writes nothing.

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
```

The field names are not decorative. They are the fields the engine will store when the
feature-brief record exists, and a draft that renamed one produces a brief that has to be
transcribed by hand before anything can read it.

`affectedComponents` draws only on the accepted component map. Never invent a component id,
and never derive one from a directory name you saw — the map is what the project accepted,
and an id outside it refers to nothing. If the project has **no accepted map**, say so in
the draft as a stated condition — *no accepted component map; components unresolved* — and
leave the field empty. That is a condition of the draft, not a gap to fill in with a guess,
and the honest answer points at the fix: `mjloop-cli profile show`, then accepting a map.

`problem` is the user's terms because that field is what the plan is judged against later.
Rewritten into your own words it becomes your understanding of the problem, and the check
that it is the right problem quietly becomes a check that you were self-consistent.

### Stop until the user approves

Present the draft and stop. Approval is the user's word, in the conversation — "yes",
"approved", "go" — and nothing else counts. Silence is not approval, and neither is a
question they asked about the draft.

If they ask for changes, change the draft and present it again. That does not cost a
question from the budget: revising a draft they are reading is not the same act as asking
them to decide something.

When they approve, say what the project's `orchestration.discovery.completion` setting is
and hand back to whoever invoked you. `auto-plan`, `review` and `save-only` are that
setting's three answers and they are the project's choice about what happens next — not
yours to carry out, and not yours to interpret as permission to keep going.

## The seam this leaves for later

The feature-brief record does not exist yet. There is no schema for it, no directory under
`.mjloop/`, and no engine operation that creates, approves or supersedes one — so for now
the draft lives in the conversation and its approval lives in the conversation with it.

That is stated here rather than papered over, because the alternative failure is silent: a
skill that told you to call an operation nobody has written would not error, it would leave
you improvising a file layout that nothing reads. Name no tool this plugin does not have.

The story that adds those records will add the operations too, and will update this skill
and `engine/tests/plugin/feature-discovery-skill.test.ts` together — the test asserts that
every engine tool this file names is one the server actually registers, so the seam is
checked rather than remembered.
