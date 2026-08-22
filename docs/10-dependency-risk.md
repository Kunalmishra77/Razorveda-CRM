# Dependency risk — reachability, not counts

**Last reviewed:** 22 Aug 2026 · **Reviewer:** engineering lead · **Next review:** with any
`npm install` that changes a root dependency, and monthly regardless.

## Why this file exists

`npm audit` counts advisories. It does not know which of them any of our code can reach, and
the difference is most of the risk. Reading the number alone pushes you toward
`npm audit fix --force`, which here would have upgraded Next and *downgraded* exceljs from 4.4.0
to 3.4.0 — silently breaking every Excel export to "fix" a bug our call site cannot trigger.

So the rule for this repo is: **every advisory gets a reachability verdict, and the verdict is
written down with the evidence that produced it.** An unreachable advisory is not ignored, it is
*accounted for* — with the specific condition that would make it live.

## What was fixed (22 Aug 2026)

18 advisories → 5. Critical: 1 → 0. High: 6 → 3.

| Action | Cleared |
|---|---|
| NestJS 10 → 11 | `multer`, `body-parser`, `qs`, `express`, `@nestjs/core`, `@nestjs/platform-express` |
| vitest 2 → 4 (all five workspaces) | `vitest` (critical), `vite`, `esbuild`, `@vitest/mocker`, `vite-node` |
| `npm audit fix` (non-breaking) | `file-type`, `@nestjs/common` |

The vitest bump had to be applied in **all five** `package.json` files, not just the root. The
first attempt changed only the root; the workspaces kept their own `^2.1.1` and npm installed a
nested vitest 2 for each, so `npm test` still ran the vulnerable version while `npm audit` still
reported it. Bumping one file and reading a green suite would have proved nothing.

## What remains, and why each one is accounted for

Five advisories remain. **None is reachable.** Each entry below states the condition that would
make it live — that condition is the thing to watch for, not the version number.

### `uuid` (moderate) — and `exceljs`, which is flagged only via it

> Missing buffer bounds check in **v3/v5/v6** when **`buf` is provided**.

`exceljs` calls it in exactly one file, `xlsx/xform/sheet/cf-ext/cf-rule-ext-xform.js`:

```js
const {v4: uuidv4} = require('uuid');
model.x14Id = `{${uuidv4()}}`.toUpperCase();
```

**v4, no arguments.** The advisory covers v3/v5/v6 with a `buf` argument. This is not a judgement
about likelihood — the vulnerable function is never called, and no argument is ever passed. It is
further used only for conditional-formatting extensions (dataBar/iconSet), which our exports do
not emit.

npm's suggested fix is `exceljs@3.4.0` — a **downgrade** across a major version. Do not take it.

*Becomes live if:* something starts calling `uuid` v3/v5/v6 directly with a `buf`.

### `postcss` (high) — and `next`, which is flagged only via it

Four advisories, all requiring **attacker-controlled CSS**: path traversal via `sourceMappingURL`
in CSS comments, and XSS via an unescaped `</style>` in stringify output.

postcss runs in our build, over our own stylesheets and Tailwind's output. Nothing user-supplied
reaches it. There is no runtime CSS compilation and no user-authored CSS anywhere in the product.

Two copies exist: vite's is already patched (8.5.26). Only Next's is vulnerable, and Next pins it
to an **exact** `"8.4.31"`, so an npm `overrides` entry does not take — this was attempted, on a
clean reinstall, and npm keeps the pinned copy regardless. A non-functioning override was removed
rather than left in place, because an override that looks like a fix and isn't one is worse than
no override.

*Becomes live if:* the product ever compiles CSS it did not author — a theming feature, a
customer-supplied stylesheet, user-controlled `style` content passed through a CSS pipeline.

### `sharp` (high) — likewise flagged onto `next`

Inherited libvips CVEs (CVE-2026-33327/33328/35590/35591). These require **decoding an
attacker-supplied image**.

`sharp` reaches us only as Next's image-optimisation dependency. The web app contains no
`next/image` and no `<Image>` — verified by search — so the optimiser never runs and sharp is
never invoked. There is no image upload path anywhere in the product; ingestion accepts CSV and
XLSX only, and the upload guard rejects anything else by magic bytes.

*Becomes live if:* anyone adds `next/image`, enables image optimisation, or accepts an image
upload.

### `next` (high) — no advisory of its own

Worth stating plainly, because the severity label is misleading: **`next` has no vulnerability.**
`npm audit` flags it solely because it depends on the two packages above. The supported fix is
Next 16, a major upgrade that would change a decided stack line (CLAUDE.md §3 names Next.js 15)
and would need the seven admin screens and both rep screens re-verified.

That is a Tier 3 call and it sits with the client. It buys **no** security benefit that fixing
postcss and sharp would not, because there is nothing in Next itself to fix.

## The one that mattered most, and the trap in it

The `multer` DoS was the scariest-reading item: high severity, on the *upload path*, in a product
whose main job is ingesting the client's spreadsheets.

It was not reachable. There is no `FileInterceptor` and no `@UploadedFile` in the tree; ingestion
takes base64 JSON. multer ships inside `@nestjs/platform-express` and is never invoked.

**The trap:** both the API controller and the web upload page carry comments promising real
multipart handling once the upload widget lands. That is the day multer moves onto a live path.
It is fixed now, so this is closed — but it is the clearest example of why the verdicts above are
written with their trigger conditions rather than as a flat "not affected". Reachability is a
property of today's code, and today's code changes.

## How to review this file

1. `npm audit`. If the count matches the table above and no new package appears, nothing to do.
2. For anything new: find the **call site**, not the package. The question is never "do we depend
   on it" but "does our code reach the vulnerable function with the vulnerable argument".
3. Re-read the *Becomes live if* lines against what shipped since the last review. Those are the
   ones that go stale silently.
4. Record the verdict here, with evidence. A verdict without the evidence that produced it cannot
   be re-checked by the next person, which makes it worth very little.
