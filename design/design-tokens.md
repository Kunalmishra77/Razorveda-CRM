# Design Tokens

Extracted from `design/prototype.html`. Use these in Tailwind config.

## Palette

| Token | Hex | Use |
|---|---|---|
| `ink` | `#14161F` | Rail, primary buttons, dark panels |
| `ink-2` | `#1D2130` | Raised surfaces inside the rail |
| `paper` | `#E7EAEE` | Workspace background (cool ledger grey, not cream) |
| `card` | `#FFFFFF` | Card surfaces |
| `line` | `#D4D9E0` | Borders |
| `line-2` | `#E8EBEF` | Interior dividers |
| `text` | `#181B24` | Body text |
| `muted` | `#606A7B` | Secondary text |
| `faint` | `#8C95A4` | Tertiary, captions |
| `brass` | `#C08A1E` | Accent — turmeric/brass. Company base, primary highlight |
| `vine` | `#1C6B49` | Positive, delivered, realised |
| `clay` | `#B03A2C` | RTO, error, negative |
| `indigo` | `#2E4A8F` | Informational |

Radius: `3px` throughout. This is an operations tool, not a consumer app.

## Type

| Role | Family | Use |
|---|---|---|
| Display / labels | **Barlow Condensed** 600 | Section headings, eyebrows, table headers, uppercase with 1.2–2px tracking |
| Body / UI | **IBM Plex Sans** 400/600 | Everything readable |
| Data | **IBM Plex Mono** 400/500, `tabular-nums` | **Every number, id, code and currency value.** Non-negotiable — columns must align in an MIS tool. |

## Signature: the attribution ribbon

The one motif that repeats everywhere and encodes something true about the business.

```
[■■■ brass ■■■][■■■■■■ vine ■■■■■■][░░░ hatched ░░░][▨ clay ▨]
  company base    realised credit   booked, unrealised  clawback
```

Use it in: Customer 360, rep dashboard, order entry preview, executive one-pager.
Same three-to-four segment reading everywhere, so people learn to read money once.

## Rules

- Numbers are always monospace with tabular figures
- Status is never encoded by colour alone — always pair with a text label
- Tables are dense: 8px vertical padding, 12.8px font
- No gradients, no shadows beyond a 1px border, no rounded cards beyond 3px
- Loading and empty states say what to do next, never "Something went wrong"
