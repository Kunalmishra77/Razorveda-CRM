# The First Prompt

Copy everything inside the code block below and paste it as your very first message to Claude Code
in this folder. Do not change anything.

---

```
You are the engineering lead on this project. Before writing any code, do the following in order
and report back — do not start building until I say go.

STEP 1 — READ
Read these files completely, in this order:
  CLAUDE.md
  docs/00-product-brief.md
  docs/08-audit-findings.md
  docs/01-architecture.md
  docs/02-data-model.md
  docs/03-metric-dictionary.md
  docs/04-report-specs.md
  docs/05-security-model.md
  docs/06-ingestion-spec.md
  docs/07-ui-spec.md
  docs/09-decisions-log.md
  tasks/phase-0-foundation.md
  tasks/phase-1-core.md
Then skim db/schema.sql, db/rls-policies.sql, everything in db/seed/, and the file names in fixtures/.
Open design/prototype.html only if you need to check what a screen should look like — it is the
visual reference for the whole product.

STEP 2 — VERIFY MY ENVIRONMENT
Run and report versions for: node, npm, docker, docker compose, psql, git.
Tell me exactly what is missing and the command to install it on my OS.
Do not install anything yourself without asking.

STEP 3 — TELL ME WHAT YOU UNDERSTOOD
In under 400 words, in your own words:
  a) What this system is and who uses it
  b) The five rules you must never break
  c) Why mobile number is not the primary key
  d) What happens between "admin uploads a file" and "a lead appears in a rep's portal"
  e) The difference between Booked and Realised, and why it matters
If any of these are unclear from the docs, say so instead of guessing.

STEP 4 — FLAG PROBLEMS
List anything in the docs that is contradictory, ambiguous, technically wrong, or that you would
build differently. Be direct. I would rather argue now than in week 10.
Also list every open decision from docs/09-decisions-log.md that blocks Phase 0 or Phase 1.

STEP 5 — PROPOSE THE PLAN
Give me a concrete Phase 0 + Phase 1 plan:
  - The exact folder structure you will scaffold
  - The order you will build in
  - What I will be able to click at the end of each week
  - Where you expect to need decisions from me
Keep it to one page. Use the phase docs as the spec, not as a suggestion.

STEP 6 — STOP
Do not scaffold, do not npm install, do not write files. Wait for me to say "go".

Constraints for the whole project:
- Follow CLAUDE.md exactly. If something conflicts with it, ask me.
- Never guess a business rule. Every rule is in docs/ — cite the section when you implement it.
- Small commits, conventional commit messages.
- When a task is over ~100 lines of code, show me the plan before you write it.
```

---

## After the kickoff

Once you have said "go", work through the phases in order using `prompts/01-phase-prompts.md`.
One prompt per phase. Never two phases in one session.

## How to run a session well

- **One phase per session.** Fresh Claude Code session per phase keeps context clean.
- **Start every session with:** `Read CLAUDE.md and tasks/phase-N-*.md, then tell me where we left off.`
- **End every session with:** `Update docs/09-decisions-log.md with anything you decided that was not
  already documented, then summarise what is done and what is next.`
- **If Claude proposes something not in the docs**, either reject it or make it log the decision.
  Undocumented decisions are how projects rot.
- **When something breaks**, use the debugging prompt in `prompts/02-utility-prompts.md` rather than
  saying "fix it". The structured version finds root causes instead of patching symptoms.
