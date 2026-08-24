'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../../lib/api';
import { s, T } from '../../../lib/ui';

/**
 * A REP'S DAY — a queue of conversations, not a table of records.
 *
 * The first version of this screen was fifty identical rows with columns for
 * source, tries and last outcome. Shown to the client, the reaction was that he
 * could not understand it himself — and if he could not, the seven women who live
 * in it eight hours a day certainly would not.
 *
 * He was right, and the diagnosis is worse than "it looks plain": it was a
 * SPREADSHEET. This product exists to replace nine Google Sheets, and the screen
 * at the centre of it had become a tenth. Four of its columns rendered as an
 * em-dash on every single row.
 *
 * WHAT A REP ACTUALLY ASKS. Not "show me my portfolio". She asks "who do I ring
 * now, and what do I say". So the page answers exactly that, in that order:
 *
 *   1. ONE call, large and unmissable, with the number set big enough to dial
 *      from and the last thing this customer said sitting right under it.
 *   2. The reason she is calling, written as a sentence a person would say out
 *      loud — never "OVERDUE_FOLLOWUP".
 *   3. Everything else, small, underneath, grouped by that same reason.
 *
 * The call card is the one dark object on the page. That is deliberate and it is
 * the only flourish here: on a screen someone stares at all day, exactly one
 * thing should pull the eye, and it should be the next piece of work.
 */

interface WorklistLead {
  leadId: string;
  band: string;
  bandLabel: string;
  fullName: string | null;
  phone: string | null;
  source: string;
  interest: string | null;
  attempts: number;
  disposition: string | null;
  followupAt: string | null;
  lifetimeOrders: number;
  lifetimeValue: string | null;
  lastRemark: string | null;
  lastContactAt: string | null;
  timingProvisional: boolean;
}

interface Payload {
  myDay: {
    monthlyTarget: string;
    realisedThisMonth: string;
    dialsToday: number;
    connectsToday: number;
    selfReported: boolean;
  };
  counts: Record<string, number>;
  bands: Array<{ band: string; label: string }>;
  leads: WorklistLead[];
}

/**
 * The reason, in words somebody would actually say.
 *
 * `OVERDUE_FOLLOWUP` is a database value. "You said you would call back" is a
 * reason. The rep reads the second one and knows what to open the call with; the
 * first one she has to be trained to decode, and training is the tax a clear
 * interface does not charge.
 */
const REASON: Record<string, { title: string; say: string; tone: string }> = {
  OVERDUE_FOLLOWUP: {
    title: 'You said you would call back',
    say: 'This was promised earlier and has not happened yet. Open with an apology for the delay.',
    tone: T.clay,
  },
  DUE_TODAY: {
    title: 'Follow-up due today',
    say: 'You set this date yourself on the last call.',
    tone: T.brass,
  },
  REPEAT_DUE: {
    title: 'Ready to order again',
    say: 'She has bought before and should be running out about now.',
    tone: T.vine,
  },
  FRESH: {
    title: 'New — nobody has called yet',
    say: 'First contact. She has just come in from the source below.',
    tone: T.indigo,
  },
  AGEING: {
    title: 'Still open',
    say: 'Not urgent, but it has been sitting a while.',
    tone: T.faint,
  },
};

const fmt = (v: string): string =>
  Number(v).toLocaleString('en-IN', { maximumFractionDigits: 0 });

/** "2 days ago" reads faster than a date when the only question is "how stale". */
function ago(iso: string | null): string | null {
  if (!iso) return null;
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? 'a month ago' : `${months} months ago`;
}

/** 9876543210 → 98765 43210. Easier to read off a screen and dial. */
const spaced = (phone: string | null): string =>
  phone && phone.length === 10 ? `${phone.slice(0, 5)} ${phone.slice(5)}` : (phone ?? '—');

export default function Worklist() {
  const router = useRouter();
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.get<Payload>('/worklist'));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        router.replace(`/login?reason=${encodeURIComponent(e.message)}`);
        return;
      }
      setError(e instanceof ApiError ? e.message : 'Could not load your worklist.');
    }
  }, [router]);

  useEffect(() => { void load(); }, [load]);

  if (error) {
    return (
      <main style={s.page}>
        <div role="alert" style={s.notice('bad')}>{error}</div>
      </main>
    );
  }
  if (!data) return <main style={s.page}><p style={s.empty}>Loading your day…</p></main>;

  const { myDay, counts, bands, leads } = data;
  const [next, ...rest] = leads;

  const target = Number(myDay.monthlyTarget);
  const realised = Number(myDay.realisedThisMonth);
  const pct = target > 0 ? Math.round((realised / target) * 100) : 0;
  const remaining = Math.max(0, target - realised);

  const today = new Date().toLocaleDateString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long',
  });

  return (
    <main style={s.page}>
      {/* Every page needs an h1, and this one earns its place: it says whose
          screen this is and what day it is. The redesign dropped it and an E2E
          test caught the regression immediately — a page with no heading is
          disorienting with a screen reader and gives a sighted reader nothing to
          anchor on either. */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <h1 style={{ ...s.h1, margin: 0 }}>My day</h1>
        <span style={{ ...s.sub, margin: 0, fontSize: 13 }}>{today} · work from the top</span>
      </div>

      {/* ---------------------------------------------------------------
          The month, in one line she can read without doing arithmetic.
          The old version showed "Balance ₹-74,36,250" — a large negative
          number, in a product where negative means clawback. Someone who
          had beaten her target by twenty-five times was being shown what
          looked like a debt.
          --------------------------------------------------------------- */}
      <section style={{ ...s.card, marginBottom: 14 }} aria-label="This month">
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 8 }}>
          <span style={{ ...s.mono, fontSize: 26, fontWeight: 600, color: pct >= 100 ? T.vine : T.text }}>
            ₹{fmt(String(realised))}
          </span>
          <span style={{ color: T.muted, fontSize: 14 }}>
            delivered this month, against a target of ₹{fmt(String(target))}
          </span>
          <span style={{ marginLeft: 'auto', ...s.pill(pct >= 100 ? 'ok' : 'flat') }}>
            {pct >= 100 ? `target met · ${pct}%` : `${pct}% there`}
          </span>
        </div>

        {/* A bar, because a percentage is a number and a bar is a feeling. */}
        <div
          role="img"
          aria-label={`${pct} percent of target`}
          style={{ height: 6, background: T.line2, borderRadius: 3, marginTop: 10, overflow: 'hidden' }}
        >
          <div style={{ width: `${Math.min(100, pct)}%`, height: '100%', background: pct >= 100 ? T.vine : T.indigo }} />
        </div>

        <p style={{ ...s.sub, margin: '10px 0 0', fontSize: 12.5 }}>
          {pct >= 100
            ? 'Target met. Everything from here adds to your incentive.'
            : `₹${fmt(String(remaining))} to go. Only delivered orders count.`}
          {' · '}
          {myDay.dialsToday} calls logged today
          {myDay.selfReported && ' (you log these yourself — you dial from your own phone)'}
        </p>
      </section>

      {/* ---------------------------------------------------------------
          THE CALL. One person, large, with the reason and the last thing
          she said. This is the only dark surface on the page.
          --------------------------------------------------------------- */}
      {next ? (
        <section
          aria-label="Call this person next"
          style={{
            background: T.ink,
            color: '#FFFFFF',
            borderRadius: 3,
            padding: '18px 20px 20px',
            marginBottom: 18,
            borderTop: `3px solid ${REASON[next.band]?.tone ?? T.indigo}`,
          }}
        >
          <p
            style={{
              font: '600 11px/1 "Barlow Condensed", sans-serif',
              textTransform: 'uppercase',
              letterSpacing: '1.8px',
              color: REASON[next.band]?.tone ?? T.faint,
              margin: '0 0 12px',
            }}
          >
            Call now · {REASON[next.band]?.title ?? next.bandLabel}
          </p>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'flex-end' }}>
            <div>
              <p style={{ font: '600 24px/1.15 "IBM Plex Sans", sans-serif', margin: '0 0 6px' }}>
                {next.fullName ?? 'Name not recorded'}
              </p>
              <p style={{ ...s.mono, fontSize: 30, letterSpacing: '1px', margin: 0, fontWeight: 500 }}>
                {spaced(next.phone)}
              </p>
            </div>

            <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
              <button
                type="button"
                onClick={async () => {
                  if (!next.phone) return;
                  await navigator.clipboard.writeText(next.phone).catch(() => undefined);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1800);
                }}
                style={{
                  font: '600 13px/1 "IBM Plex Sans", sans-serif',
                  background: 'transparent',
                  color: '#FFFFFF',
                  border: '1px solid rgba(255,255,255,.35)',
                  borderRadius: 3,
                  padding: '11px 16px',
                  cursor: 'pointer',
                }}
              >
                {copied ? 'Copied' : 'Copy number'}
              </button>
              <Link
                href={`/leads/${next.leadId}`}
                style={{
                  font: '600 13px/1 "IBM Plex Sans", sans-serif',
                  background: '#FFFFFF',
                  color: T.ink,
                  borderRadius: 3,
                  padding: '11px 18px',
                  textDecoration: 'none',
                }}
              >
                Open &amp; log the call
              </Link>
            </div>
          </div>

          {/* Why her, and what happened last time. The two things you want in
              your head before the line connects. */}
          <div
            style={{
              marginTop: 16,
              paddingTop: 14,
              borderTop: '1px solid rgba(255,255,255,.14)',
              display: 'grid',
              gap: 10,
              gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
              fontSize: 13.5,
              lineHeight: 1.55,
            }}
          >
            <div>
              <Small>Why she is on your list</Small>
              <p style={{ margin: 0, color: 'rgba(255,255,255,.9)' }}>
                {REASON[next.band]?.say ?? next.bandLabel}
              </p>
              {next.timingProvisional && (
                <p style={{ margin: '6px 0 0', color: T.brass, fontSize: 12.5 }}>
                  The reorder date is an estimate — she may not have run out yet. Ask before assuming.
                </p>
              )}
            </div>

            <div>
              <Small>Last time you spoke</Small>
              <p style={{ margin: 0, color: 'rgba(255,255,255,.9)' }}>
                {next.lastRemark
                  ? `“${next.lastRemark}” — ${ago(next.lastContactAt) ?? 'earlier'}`
                  : next.attempts > 0
                    ? `${next.attempts} attempt(s), nothing written down.`
                    : 'You have not spoken to her yet.'}
              </p>
            </div>

            <div>
              <Small>What she has bought</Small>
              <p style={{ margin: 0, color: 'rgba(255,255,255,.9)' }}>
                {next.lifetimeOrders > 0
                  ? `${next.lifetimeOrders} delivered order${next.lifetimeOrders > 1 ? 's' : ''}, ₹${fmt(next.lifetimeValue ?? '0')} in total.`
                  : 'Nothing yet — this would be her first.'}
              </p>
              <p style={{ margin: '4px 0 0', color: 'rgba(255,255,255,.55)', fontSize: 12.5 }}>
                Came from {next.source}
                {next.interest ? ` · interested in ${next.interest}` : ''}
              </p>
            </div>
          </div>
        </section>
      ) : (
        <section style={{ ...s.card, textAlign: 'center', padding: '38px 20px', marginBottom: 18 }}>
          <p style={{ font: '600 18px/1.3 "IBM Plex Sans", sans-serif', margin: '0 0 6px' }}>
            Nothing waiting for you right now.
          </p>
          <p style={{ ...s.sub, margin: 0 }}>
            When an admin assigns you leads, or a customer is due to reorder, they appear here.
          </p>
        </section>
      )}

      {/* ---------------------------------------------------------------
          The rest, grouped by the SAME reason wording as the card above,
          so the two halves of the page speak one language.
          --------------------------------------------------------------- */}
      {rest.length > 0 && (
        <section aria-label="The rest of your list">
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 10 }}>
            <h2 style={{ ...s.h1, fontSize: 15, margin: 0 }}>Then these</h2>
            <span style={{ ...s.sub, margin: 0, fontSize: 12.5 }}>
              {rest.length} more today · worked top to bottom
            </span>
          </div>

          {bands.map(({ band }) => {
            const group = rest.filter((l) => l.band === band);
            if (group.length === 0) return null;
            const reason = REASON[band];

            return (
              <div key={band} style={{ marginBottom: 14 }}>
                <p
                  style={{
                    font: '600 11px/1 "Barlow Condensed", sans-serif',
                    textTransform: 'uppercase',
                    letterSpacing: '1.6px',
                    color: reason?.tone ?? T.muted,
                    margin: '0 0 6px',
                  }}
                >
                  {reason?.title ?? band} · {counts[band] ?? group.length}
                </p>

                <div style={{ display: 'grid', gap: 6 }}>
                  {group.map((l) => (
                    <Link
                      key={l.leadId}
                      href={`/leads/${l.leadId}`}
                      style={{
                        ...s.card,
                        padding: '11px 14px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 14,
                        textDecoration: 'none',
                        color: T.text,
                        borderLeft: `3px solid ${reason?.tone ?? T.line}`,
                      }}
                    >
                      <span style={{ fontWeight: 500, minWidth: 170 }}>
                        {l.fullName ?? <span style={{ color: T.faint }}>Name not recorded</span>}
                      </span>
                      <span style={{ ...s.mono, color: T.muted }}>{spaced(l.phone)}</span>

                      {l.lastRemark && (
                        <span
                          style={{
                            color: T.muted,
                            fontSize: 13,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            maxWidth: 320,
                          }}
                          title={l.lastRemark}
                        >
                          “{l.lastRemark}”
                        </span>
                      )}

                      {l.lifetimeOrders > 0 && (
                        <span style={{ ...s.pill('ok'), fontSize: 10 }}>
                          {l.lifetimeOrders}× buyer
                        </span>
                      )}
                      {l.timingProvisional && (
                        <span style={{ ...s.pill('warn'), fontSize: 10 }}>timing estimated</span>
                      )}

                      <span style={{ marginLeft: 'auto', color: T.indigo, fontSize: 13, fontWeight: 500 }}>
                        Open →
                      </span>
                    </Link>
                  ))}
                </div>
              </div>
            );
          })}
        </section>
      )}
    </main>
  );
}

/** A label inside the dark card, where the normal muted token has no contrast. */
function Small({ children }: { children: React.ReactNode }) {
  return (
    <p
      style={{
        font: '600 10.5px/1 "Barlow Condensed", sans-serif',
        textTransform: 'uppercase',
        letterSpacing: '1.5px',
        color: 'rgba(255,255,255,.5)',
        margin: '0 0 5px',
      }}
    >
      {children}
    </p>
  );
}
