# Utility Prompts

Reusable prompts for common situations. Paste as-is.

---

## Start of any session
```
Read CLAUDE.md and the phase doc we are currently on. Run `git log --oneline -15` and tell me where
we left off, what is done, and what the next task is. Do not start work yet.
```

## End of any session
```
Update docs/09-decisions-log.md with every decision you made this session that was not already
documented. Then give me: what is done, what is half-done, what is next, and anything you need from
me before the next session.
```

## Debugging — use this instead of "fix it"
```
Something is wrong: [symptom, exact error, steps to reproduce].

Do not patch it yet. First:
1. What did you expect to happen, and what actually happened?
2. List three plausible root causes, ranked by likelihood.
3. What evidence would confirm or eliminate each one?
4. Gather that evidence — read the code, query the DB, add a temporary log — and tell me which
   cause it actually is.
Only then propose a fix, and tell me what test would have caught this.
```

## Code review
```
Review everything changed since [commit/branch] against CLAUDE.md. Check specifically:
- Any LLM call touching a number, a status, or an assignment (forbidden)
- Any UPDATE or DELETE on an append-only table (forbidden)
- Any query relying on an application WHERE clause where an RLS policy should exist
- Any business rule implemented without a citing test
- Any `any`, silent catch, or unhandled promise
- Any UI error state saying "something went wrong" instead of what to do next
Report by severity. Do not fix anything yet.
```

## Changing a business rule
```
I want to change a business rule: [describe it].
Before implementing:
1. Which doc section owns this rule today, and what does it currently say?
2. Every place in the codebase that depends on it.
3. What breaks in historical reports if we change it — do we need an effective date?
Then update the doc first, then the code, then the tests.
```

## Before every phase handover
```
Go through the exit criteria in tasks/phase-N-*.md one at a time. For each, give me a command I can
run myself that proves it passes, and run it. If a criterion cannot be proven by a command, say why
and what manual check to do instead. Do not mark the phase done until all pass.
```

## When Claude wants to add a dependency
```
Before adding that: what does it do that we cannot do in ~50 lines ourselves? How many transitive
dependencies does it bring? When was it last updated? Does it conflict with CLAUDE.md section 9
(deliberate simplicity)? Answer before installing.
```

## Writing tests for a business rule
```
Write tests for [rule], citing the doc section in the test description.
Cover: the happy path, the boundary, the client's actual messy data from fixtures/, and the case
that would silently produce a WRONG NUMBER rather than an error. That last one matters most — this
is an MIS system, and a wrong number that looks right is worse than a crash.
```

## Performance check
```
Profile the [screen/report]. Show me the actual SQL being run, the EXPLAIN ANALYZE for anything over
100ms, and the N+1 queries if any. Fix by adding indexes or restructuring the query — not by adding
a cache. We have 2,000 rows a day; if something is slow at this scale, the query is wrong.
```
