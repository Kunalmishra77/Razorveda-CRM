'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../../lib/api';
import { s, T } from '../../../lib/ui';

/**
 * Audit & Security (docs/05, Phase 5 deliverables 5 and 6).
 *
 * The screen that makes the copy-velocity lock survivable.
 *
 * The lock can put a rep out of the system mid-shift. Until this existed the only
 * way back was an admin with database access — so a control designed to catch
 * exfiltration was, in practice, a way to lose a working day. The unlock is the
 * first thing on the page for that reason.
 *
 * Every destructive action here asks for a reason in words, and the reason goes
 * on the audit trail. Not friction for its own sake: whoever investigates the
 * next incident needs to know what was concluded about this one.
 */

interface LockedAccount {
  user_id: string;
  email: string;
  role: string;
  full_name: string | null;
  locked_reason: string | null;
  locked_at: string | null;
}

interface AccessRow {
  rep: string | null; day: string;
  views: number; copies: number;
  distinct_customers: number; distinct_addresses: number;
}

interface SessionRow {
  email: string; role: string; full_name: string | null;
  sessions: number; last_seen: string | null; addresses: number;
}

interface AlertRow {
  slot_key: string; subject: string; body: string;
  created_at: string; admins_notified: number; resolved: boolean;
}

export default function SecurityPage() {
  const [locked, setLocked] = useState<LockedAccount[]>([]);
  const [access, setAccess] = useState<AccessRow[]>([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [sessionWarning, setSessionWarning] = useState<string | null>(null);
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [from, setFrom] = useState(daysAgo(7));
  const [to, setTo] = useState(today());

  const load = useCallback(async () => {
    setError(null);
    try {
      const [l, a, sess, v] = await Promise.all([
        api.get<{ accounts: LockedAccount[] }>('/security/locked'),
        api.get<{ rows: AccessRow[] }>(`/security/access-log?from=${from}&to=${to}`),
        api.get<{ rows: SessionRow[]; warning?: string }>('/security/sessions'),
        api.get<{ alerts: AlertRow[] }>('/security/velocity-alerts'),
      ]);
      setLocked(l.accounts);
      setAccess(a.rows);
      setSessions(sess.rows);
      setSessionWarning(sess.warning ?? null);
      setAlerts(v.alerts);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The security console could not be loaded.');
    }
  }, [from, to]);

  useEffect(() => { void load(); }, [load]);

  async function unlock(userId: string, who: string) {
    setError(null);
    setNote(null);
    try {
      const r = await api.post<{ ok: boolean; message?: string }>('/security/unlock', {
        userId, reason,
      });
      if (!r.ok) { setError(r.message ?? 'That account could not be unlocked.'); return; }
      setNote(`${who} can sign in again. The unlock and your reason are on the audit trail.`);
      setUnlocking(null);
      setReason('');
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That account could not be unlocked.');
    }
  }

  return (
    <main style={s.page}>
      <h1 style={s.h1}>Audit &amp; Security</h1>
      <p style={s.lede}>
        Reps see full phone numbers because they dial from their own handsets. That removes
        prevention and leaves detection and attribution — which is what this page is.
      </p>

      {error && <div role="alert" style={s.notice('bad')}>{error}</div>}
      {note && <div style={s.notice('ok')}>{note}</div>}

      <section style={s.card}>
        <div style={s.cardHead}>
          <span>Locked accounts</span>
          <span style={{ color: T.muted, fontSize: 12 }}>{locked.length}</span>
        </div>

        {locked.length === 0 ? (
          <p style={s.empty}>Nobody is locked out.</p>
        ) : (
          locked.map((a) => (
            <div key={a.user_id} style={{ borderTop: `1px solid ${T.line}`, padding: '12px 0' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <div>
                  <strong>{a.full_name ?? a.email}</strong>
                  <span style={{ ...s.mono, color: T.muted, marginLeft: 8, fontSize: 12 }}>{a.role}</span>
                  <div style={{ color: T.muted, fontSize: 12.5, marginTop: 4, maxWidth: 620 }}>
                    {a.locked_reason ?? 'No reason recorded.'}
                  </div>
                </div>
                {unlocking !== a.user_id && (
                  <button type="button" style={s.btn} onClick={() => { setUnlocking(a.user_id); setReason(''); }}>
                    Unlock
                  </button>
                )}
              </div>

              {unlocking === a.user_id && (
                <div style={{ marginTop: 10 }}>
                  <label style={s.label} htmlFor={`reason-${a.user_id}`}>
                    What did you conclude? This goes on the audit trail.
                  </label>
                  <input
                    id={`reason-${a.user_id}`} value={reason} onChange={(e) => setReason(e.target.value)}
                    placeholder="Spoke to her — she was copying numbers into her phone before a call block."
                    style={{ ...s.input, maxWidth: 620 }}
                  />
                  {/* The innocent explanations, in front of the admin at the moment
                      they decide. An alert that reads as an accusation gets someone
                      in trouble for a stuck key. */}
                  <p style={s.hint}>
                    There are innocent explanations: a stuck key, a browser extension, a rep copying
                    numbers into her own phone in a batch before a call block. Look at her copy history
                    below before you speak to her.
                  </p>
                  <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                    <button
                      type="button"
                      disabled={reason.trim().length < 10}
                      style={reason.trim().length < 10 ? s.btnDisabled : s.btnPrimary}
                      onClick={() => void unlock(a.user_id, a.full_name ?? a.email)}
                    >
                      Unlock {a.full_name ?? a.email}
                    </button>
                    <button type="button" style={s.btn} onClick={() => setUnlocking(null)}>Cancel</button>
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </section>

      <section style={s.card}>
        <div style={s.cardHead}>
          <span>Velocity alerts</span>
          <span style={{ color: T.muted, fontSize: 12 }}>{alerts.length}</span>
        </div>
        {alerts.length === 0 ? (
          <p style={s.empty}>No account has ever tripped the copy-velocity lock.</p>
        ) : (
          <table style={s.table}>
            <thead><tr>{['When', 'Alert', 'Admins told', 'Reviewed'].map((h) => (
              <th key={h} scope="col" style={s.th}>{h}</th>))}</tr></thead>
            <tbody>
              {alerts.map((a) => (
                <tr key={a.slot_key}>
                  <td style={s.td}>{when(a.created_at)}</td>
                  <td style={s.td}>{a.subject}</td>
                  <td style={{ ...s.td, ...s.mono, textAlign: 'right' }}>{a.admins_notified}</td>
                  <td style={s.td}>
                    <span style={{ color: a.resolved ? T.vine : T.brass }}>
                      {a.resolved ? 'reviewed' : 'not yet reviewed'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section style={s.card}>
        <div style={s.cardHead}>
          <span>Phone numbers viewed and copied</span>
          <span style={{ display: 'flex', gap: 8 }}>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ ...s.input, width: 150 }} />
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ ...s.input, width: 150 }} />
          </span>
        </div>
        {access.length === 0 ? (
          <p style={s.empty}>Nothing recorded in this period.</p>
        ) : (
          <>
            <table style={s.table}>
              <thead><tr>{['Rep', 'Day', 'Views', 'Copies', 'Customers', 'Addresses'].map((h) => (
                <th key={h} scope="col" style={s.th}>{h}</th>))}</tr></thead>
              <tbody>
                {access.map((r, i) => (
                  <tr key={i}>
                    <td style={s.td}>{r.rep ?? '—'}</td>
                    <td style={{ ...s.td, ...s.mono }}>{String(r.day).slice(0, 10)}</td>
                    <td style={{ ...s.td, ...s.mono, textAlign: 'right' }}>{r.views}</td>
                    <td style={{ ...s.td, ...s.mono, textAlign: 'right', color: r.copies > 50 ? T.brass : undefined }}>
                      {r.copies}
                    </td>
                    <td style={{ ...s.td, ...s.mono, textAlign: 'right' }}>{r.distinct_customers}</td>
                    <td style={{ ...s.td, ...s.mono, textAlign: 'right', color: r.distinct_addresses > 1 ? T.brass : undefined }}>
                      {r.distinct_addresses}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p style={s.hint}>
              A rep who VIEWS two hundred leads a day is working. A rep who COPIES two hundred is
              doing something else. More than one address in a day is worth a question, not an accusation.
            </p>
          </>
        )}
      </section>

      <section style={s.card}>
        <div style={s.cardHead}><span>Who is signed in</span><span /></div>
        {sessionWarning && <div style={s.notice('warn')}>{sessionWarning}</div>}
        {sessions.length === 0 ? (
          <p style={s.empty}>Nobody has a live session.</p>
        ) : (
          <table style={s.table}>
            <thead><tr>{['Person', 'Role', 'Sessions', 'Addresses', 'Last seen'].map((h) => (
              <th key={h} scope="col" style={s.th}>{h}</th>))}</tr></thead>
            <tbody>
              {sessions.map((r) => (
                <tr key={r.email}>
                  <td style={s.td}>{r.full_name ?? r.email}</td>
                  <td style={{ ...s.td, ...s.mono, fontSize: 12 }}>{r.role}</td>
                  <td style={{
                    ...s.td, ...s.mono, textAlign: 'right',
                    // docs/05 allows one session per EMPLOYEE. Two is the rule broken.
                    color: r.role === 'EMPLOYEE' && r.sessions > 1 ? T.clay : undefined,
                  }}>{r.sessions}</td>
                  <td style={{ ...s.td, ...s.mono, textAlign: 'right' }}>{r.addresses}</td>
                  <td style={s.td}>{when(r.last_seen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}

const today = (): string => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number): string =>
  new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

const when = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
