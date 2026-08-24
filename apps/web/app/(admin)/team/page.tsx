'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../../lib/api';
import { s, T } from '../../../lib/ui';

/**
 * THE TEAM — seven people, and until now the admin could not open any of them.
 *
 * Everything about a rep existed somewhere. The roster sat in Master Data next to
 * prices and incentive slabs, because that is where targets are edited. Her
 * numbers were a row in a report. Her leads were reachable only through the
 * assignment screen. What did not exist was the question an admin actually asks,
 * which is about a PERSON: how is Divya doing, and what is she sitting on.
 *
 * So this is a list of PEOPLE, not a table of metrics. Four numbers each — enough
 * to decide who gets the next batch and who needs a conversation — and everything
 * else one click away on the person. A fourteen-column table is one nobody reads.
 *
 * The three numbers that earn their place, and why:
 *
 *   NEVER CALLED  work she is holding and has not started. This is what an admin
 *                 redistributes on, and it is the only honest basis for it —
 *                 moving a lead mid-conversation helps nobody.
 *   AT RISK       untouched 48h. At 72 the lead returns to the pool on its own
 *                 (rule 6), so this is the window where a person can still act.
 *   LAST SEEN     when she last logged anything. A rep who has not made a call in
 *                 four days is a conversation, not a metric, and nothing in the
 *                 product said so.
 */

interface Member {
  employee_id: string;
  emp_code: string;
  full_name: string;
  status: string;
  monthly_target: string;
  wip_cap: number;
  open_leads: string;
  never_called: string;
  at_risk: string;
  overdue: string;
  calls_today: string;
  connected_today: string;
  delivered_month: string;
  last_activity_at: string | null;
}

const n = (v: string | null | undefined): number => Number(v ?? '0');
const money = (v: string | number): string =>
  Number(v).toLocaleString('en-IN', { maximumFractionDigits: 0 });

/** "3 days ago" beats a timestamp when the question is "is she working". */
function since(iso: string | null): { label: string; stale: boolean } {
  if (!iso) return { label: 'never', stale: true };
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return { label: 'today', stale: false };
  if (days === 1) return { label: 'yesterday', stale: false };
  return { label: `${days} days ago`, stale: days >= 4 };
}

export default function Team() {
  const [team, setTeam] = useState<Member[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setTeam((await api.get<{ team: Member[] }>('/team')).team);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load the team.');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (error) return <main style={s.page}><div role="alert" style={s.notice('bad')}>{error}</div></main>;
  if (!team) return <main style={s.page}><p style={s.empty}>Loading the team…</p></main>;

  const active = team.filter((m) => m.status === 'ACTIVE');
  const openTotal = team.reduce((a, m) => a + n(m.open_leads), 0);
  const riskTotal = team.reduce((a, m) => a + n(m.at_risk), 0);

  return (
    <main style={s.page}>
      <h1 style={s.h1}>Team</h1>
      <p style={s.sub}>
        {active.length} working today · {openTotal} open leads between them
        {riskTotal > 0 ? ` · ${riskTotal} untouched for 48 hours` : ''}
      </p>

      <section style={{ ...s.card, overflowX: 'auto' }}>
        <table style={s.table}>
          <caption style={s.srOnly}>The team, with open work and today&apos;s activity.</caption>
          <thead>
            <tr>
              <th scope="col" style={s.th}>Rep</th>
              <th scope="col" style={{ ...s.th, textAlign: 'right' }}>Open</th>
              <th scope="col" style={{ ...s.th, textAlign: 'right' }}>Never called</th>
              <th scope="col" style={{ ...s.th, textAlign: 'right' }}>At risk</th>
              <th scope="col" style={{ ...s.th, textAlign: 'right' }}>Overdue</th>
              <th scope="col" style={{ ...s.th, textAlign: 'right' }}>Calls today</th>
              <th scope="col" style={{ ...s.th, textAlign: 'right' }}>Delivered this month</th>
              <th scope="col" style={s.th}>Last seen</th>
            </tr>
          </thead>
          <tbody>
            {team.map((m) => {
              const target = n(m.monthly_target);
              const delivered = n(m.delivered_month);
              const pct = target > 0 ? Math.round((delivered / target) * 100) : null;
              const seen = since(m.last_activity_at);
              const away = m.status !== 'ACTIVE';
              return (
                <tr key={m.employee_id} style={away ? { color: T.faint } : undefined}>
                  <td style={s.td}>
                    <Link href={`/team/${m.employee_id}`} style={{ color: T.text, fontWeight: 500 }}>
                      {m.full_name}
                    </Link>
                    <span style={{ ...s.mono, color: T.faint, fontSize: 11, marginLeft: 8 }}>
                      {m.emp_code}
                    </span>
                    {away && (
                      <span style={{ ...s.pill('warn'), marginLeft: 8 }}>
                        {m.status.toLowerCase().replace('_', ' ')}
                      </span>
                    )}
                  </td>
                  <td style={{ ...s.td, ...s.mono, textAlign: 'right' }}>{m.open_leads}</td>
                  <td style={{ ...s.td, ...s.mono, textAlign: 'right' }}>{m.never_called}</td>
                  <td style={{
                    ...s.td, ...s.mono, textAlign: 'right',
                    color: n(m.at_risk) > 0 ? T.clay : undefined,
                  }}>
                    {m.at_risk}
                  </td>
                  <td style={{
                    ...s.td, ...s.mono, textAlign: 'right',
                    color: n(m.overdue) > 0 ? T.brass : undefined,
                  }}>
                    {m.overdue}
                  </td>
                  <td style={{ ...s.td, ...s.mono, textAlign: 'right' }}>
                    {m.calls_today}
                    {n(m.calls_today) > 0 && (
                      <span style={{ color: T.faint, fontSize: 11.5 }}> · {m.connected_today} answered</span>
                    )}
                  </td>
                  <td style={{ ...s.td, ...s.mono, textAlign: 'right' }}>
                    ₹{money(delivered)}
                    {pct !== null && (
                      <span style={{ color: pct >= 100 ? T.vine : T.faint, fontSize: 11.5 }}>
                        {' '}· {pct}%
                      </span>
                    )}
                  </td>
                  <td style={{ ...s.td, color: seen.stale ? T.clay : T.muted, fontSize: 12.5 }}>
                    {seen.label}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <p style={{ ...s.sub, marginTop: 10, fontSize: 12.5 }}>
        <strong>At risk</strong> means assigned 48 hours ago and never touched. At 72 hours the lead
        goes back to the pool on its own — you can move it before then from{' '}
        <Link href="/assignment" style={{ color: T.indigo }}>Lead Assignment → Move work</Link>.
      </p>
    </main>
  );
}
