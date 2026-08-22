# Admin runbook

For the three people who run Razorveda's day. Everything here is a real screen —
no command line, no spreadsheet.

If something in this document does not match what you see, the document is wrong.
Tell whoever maintains the system; do not work around it.

---

## Before the first day

These four things must be done once, in order, or nothing else works.

### 1. Claim the OWNER account

The system ships with a locked OWNER account that has nobody's name on it. It
stays locked until a real person claims it. Until then, the OWNER-only powers —
managing admins, targets and incentive rules — belong to nobody.

An admin unlocks it from **Audit & Security → Locked accounts** after the owner's
email has been set.

### 2. Set up two-factor for every admin

Admins cannot sign in without an authenticator. Reps do not need one.

On the sign-in page, enter your email and password and choose **Set up two-factor**.
Scan the QR code with Google Authenticator, Authy, or any TOTP app, then type the
six-digit code to confirm.

**You get one chance.** If you lose the phone afterwards, another admin has to
reset it for you — the account cannot re-link itself, because if it could, anyone
with your password could take it permanently.

### 3. Confirm every Shopify base price

**Master Data → Shopify base prices.** Unconfirmed products are listed first.

The base price is what the company had already committed before a rep touched the
order — the value in the cart the customer built themselves. The rep is credited
the order value *minus* it.

**A product with no confirmed base price earns its rep nothing.** Orders on it
book normally, the sale is recorded, and no credit is calculated until you enter
a price here. The 08:00 exception digest counts these every morning.

A price above MRP is refused: the rep's credit would be negative, which means the
figure is a typo.

### 4. Enter the incentive scheme

**Master Data → Incentive scheme.**

What ships is the *proposal* from the design documents, not Razorveda's scheme.
Until you replace it and tick **confirmed**, every incentive figure carries
"PROVISIONAL — do not pay against this figure."

Slabs must cover the whole range with no gaps, starting at 0. A gap is refused
here rather than at month end, when a rep landing in it would have no slab at all.

Editing does not overwrite. It closes the old scheme and opens a new one from a
date you choose, so last month still recomputes to last month's rules.

---

## Every morning

### 07:30 — the reps get their plans automatically

Nothing for you to do. Each rep receives her gap to target, overdue follow-ups,
repeat-due customers and untouched leads.

> **Not yet reaching anyone.** No email or WhatsApp provider is configured, so
> digests are written to a folder on the server. **Audit & Security** and the
> `/digests/sent` view both say so plainly. This is the one thing on this page
> that is built and not connected.

### 08:00 — read the exception digest

It counts five things. Each one has a screen:

| It says | Go to | Why it matters |
|---|---|---|
| leads untouched over 48h | Lead Assignment | They return to the pool at 72h |
| leads sitting unassigned | Lead Assignment | Nobody is working them |
| staged rows awaiting review | Upload Centre → the batch | The upload is not finished |
| SKUs with no confirmed price | Master Data | Those reps are earning nothing |
| orders with no movement for 7 days | Orders & RTO | Somebody has forgotten a parcel |

### Upload the day's files

**Upload Centre.** One file per channel. CSV only — if you have a spreadsheet,
use *File → Save As → CSV UTF-8* first. The system will tell you if you upload an
XLSX by mistake, and tell you how to fix it.

What happens next, in order:

1. **The same file twice is refused**, naming the earlier batch. If you meant to
   replace it, roll that batch back first.
2. **Column shift is caught before anything is saved.** If more than a fifth of a
   column fails its type check — customer names inside the Order Status column,
   PIN codes inside Client Category — the whole batch is rejected and nothing is
   staged. Fix the export and upload again.
3. **Rows are checked one at a time.** Clean rows go through; problem rows are
   listed for you.

### Review the exceptions

Open the batch. You see **only the rows that need a decision** — a 500-row file
with 26 problems shows you 26 rows, not 500.

The common ones:

- **No usable mobile.** Parked, never discarded. Roughly one row in nine has this.
- **Ambiguous date.** `2026-12-06` could be two things. It says which it chose.
- **Mis-encoded name.** `à¤®à¥‹à¤¹à¤¨` is repaired to `मोहन` where possible. If
  characters were destroyed before the file reached us, it says so and asks you to
  check the spelling with the customer.
- **Payment unclear.** `300 prepaid & 2200 cod` parses. Genuinely ambiguous text
  is flagged.
- **Merge candidate.** This person may already exist. You decide.

Then **Commit**. Customers, leads and orders are created. If something is wrong,
**Roll back** within seven days — leads close, orders cancel, ledger entries
reverse. Customers created by the batch are kept and the count is reported: one of
them may have been called since, and deleting that is worse than keeping a row.

### Assign the pool

**Lead Assignment.** Select leads, choose a rep, assign. There is no automatic
distribution and there will not be — you know things the system does not.

The **Assignment Quality** report (Reports & MIS, weekly) tells you which rep
converts which kind of lead, by value per lead rather than by count. Read it on
Monday and assign better on Tuesday.

---

## Through the day

### Move orders

**Orders & RTO.** Confirm, process, dispatch, out for delivery, delivered, RTO.

**Marking an order delivered is what pays the rep.** Marking a delivered order
returned takes it back. Both are marked on the screen so nobody clicks one
thinking it is routine.

Reps can confirm and cancel their own orders — they are the ones the customer
speaks to. They cannot dispatch or deliver, because those are courier facts and a
rep who could mark her own order delivered could pay herself.

### 14:00 — the zero-dials alert

If a rep has assigned leads and no calls logged by two o'clock, you are told.

Dials are self-reported, so this means nothing has been **recorded**. She may have
been calling without logging it, which is its own problem — the follow-up is a
conversation, not an accusation.

---

## Every week

**Monday, Reports & MIS:**

- **Weekly Team Pack** — the week against target, per rep
- **Source Performance** — which channels are worth the money
- **Assignment Quality** — the one to act on

---

## Every month

**Reports & MIS → month-close pack.** Nine sections in one click, built from the
event log — so running August in December returns August, exactly.

Read them in order. Section 2b, **credit reconciliation**, exists because sections
1 and 2 look contradictory at first glance: a rep can deliver ₹153,000 and have an
incentive base of ₹3,000. Both are right. The reconciliation names the gap per rep
and counts the delivered orders that carry no ledger entry at all.

Export any report to Excel with the **Export XLSX** button. Every export is
watermarked with your name and logged. Reps cannot export anything.

---

## When something goes wrong

### A rep is locked out

**Audit & Security → Locked accounts.**

If she copied four phone numbers within ninety seconds, the system locked her
account, ended her sessions and told every admin. That pace is machine-like — a
person working leads copies one number and then talks for four minutes.

**Look at her copy history before you speak to her.** The innocent explanations
are real: a stuck key, a browser extension, a rep copying numbers into her own
phone in a batch before a call block.

Unlock requires a sentence saying what you concluded. It goes on the audit trail,
and whoever looks at the next incident will need it.

### Somebody leaves

**Audit & Security → offboarding.** Preview first — thirty leads returning to an
unwatched pool on a Friday afternoon is a different decision from three.

What happens: her sessions end, her account locks, her live leads return to the
**pool** with your handover note attached to each, and the customers she owned are
released so their reorders do not land on a list nobody reads.

What does not happen: her record is never deleted. Her orders stay credited to
her — credit is earned on delivery and the sale was hers — and in-transit orders
are **reported**, not reassigned. Somebody needs to chase those couriers.

### Restore from backup

Run the drill monthly. `npm run db:restore-drill` — the only command in this
document, and it belongs to whoever maintains the server rather than to you.

It restores into a scratch database and checks seven things, including whether
row-level security survived. A restore that loses that would start cleanly and
show every rep every customer.

Details in the README.

---

## What the system will not do, and why

- **Assign leads automatically.** Removed at Razorveda's request. You decide.
- **Let a rep export anything.** There is no button. That is the protection.
- **Let a rep mark her own order delivered.** That is the transition that pays her.
- **Pay on booked value.** Credit is earned on delivery. A returned order is
  clawed back, and the two net to zero.
- **Change a past month.** Every report is built from an append-only event log.
  August cannot become a different August.
