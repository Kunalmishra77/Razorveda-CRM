'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError, type ExceptionRow } from '../../../../lib/api';
import { s, statusTone, T } from '../../../../lib/ui';

/**
 * Exception Review (docs/07 module 2, docs/06 stage 6).
 *
 * "Admin sees ONLY rows with status WARNING, ERROR or DUPLICATE. Clean rows are
 * never rendered — that is the entire point."
 *
 * The API enforces that too: there is no parameter that returns a VALID row. This
 * screen could not show you a clean row if it wanted to, which is why a 500-row
 * day is a 26-row review.
 */
export default function ExceptionReview() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const batchId = params.id;

  const [rows, setRows] = useState<ExceptionRow[]>([]);
  const [counts, setCounts] = useState<Array<{ status: string; n: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ exceptions: ExceptionRow[]; counts: Array<{ status: string; n: string }> }>(
        `/ingestion/batches/${batchId}/exceptions`,
      );
      setRows(r.exceptions);
      setCounts(r.counts);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load this batch.');
    }
  }, [batchId]);

  useEffect(() => { void load(); }, [load]);

  const total = counts.reduce((sum, c) => sum + Number(c.n), 0);
  const clean = Number(counts.find((c) => c.status === 'VALID')?.n ?? 0);
  const warnings = rows.filter((r) => r.validation_status === 'WARNING').length;
  const blocking = rows.filter((r) => r.validation_status === 'ERROR' || r.validation_status === 'PARKED').length;

  async function acceptWarnings() {
    setBusy(true);
    try {
      const r = await api.post<{ accepted: number }>(`/ingestion/batches/${batchId}/accept-warnings`);
      setNote(`Accepted ${r.accepted} warning row${r.accepted === 1 ? '' : 's'}.`);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not accept those warnings.');
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{
        ok: boolean; message?: string;
        customersCreated?: number; leadsCreated?: number; ordersCreated?: number; rowsSkipped?: number;
      }>(`/ingestion/batches/${batchId}/commit`);

      if (!r.ok) { setError(r.message ?? 'That batch could not be committed.'); return; }
      setNote(
        `Committed. ${r.customersCreated} customers, ${r.leadsCreated} leads, ${r.ordersCreated} orders. ` +
          `${r.rowsSkipped ? `${r.rowsSkipped} row(s) left in staging.` : ''} ` +
          `Leads are in the unassigned pool — nothing was assigned.`,
      );
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That commit failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={s.page}>
      <h1 style={s.h1}>Exception review</h1>
      <p style={s.sub}>
        <Link href="/upload" style={{ color: T.muted }}>← Upload Centre</Link>
        {'   ·   '}
        <span style={s.mono}>batch {batchId.slice(0, 8)}</span>
      </p>

      {error && <div role="alert" style={s.notice('bad')}>{error}</div>}
      {note && <div style={s.notice('ok')}>{note}</div>}

      <section style={s.card}>
        <div style={s.cardHead}><span>This batch</span><span style={s.mono}>{total} rows</span></div>
        <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', fontSize: 13 }}>
          <Figure label="Clean" value={clean} tone={T.vine} />
          <Figure label="Needs a look" value={rows.length} tone={rows.length ? T.brass : T.faint} />
          <Figure label="Blocking" value={blocking} tone={blocking ? T.clay : T.faint} />
        </div>
        <p style={{ ...s.sub, margin: '12px 0 0', fontSize: 12 }}>
          Clean rows are never shown here. Only the {rows.length} row{rows.length === 1 ? '' : 's'} below
          need you.
        </p>
      </section>

      <section style={s.card} aria-label="Exceptions">
        <div style={s.cardHead}>
          <span>Exceptions</span>
          <span>
            {warnings > 0 && (
              <button type="button" onClick={() => void acceptWarnings()} disabled={busy} style={busy ? s.btnDisabled : s.btn}>
                Accept all {warnings} warning{warnings === 1 ? '' : 's'}
              </button>
            )}
          </span>
        </div>

        {rows.length === 0 ? (
          <p style={s.empty}>
            Nothing to review. {clean > 0 ? 'Every row read cleanly — commit when you are ready.' : ''}
          </p>
        ) : (
          <table style={s.table}>
            <thead>
              <tr>
                {['Row', 'Status', 'What is wrong', 'As read from the file'].map((h) => (
                  <th key={h} scope="col" style={s.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.staging_id}>
                  <td style={{ ...s.td, ...s.mono }}>{r.row_number}</td>
                  <td style={s.td}>
                    <span style={s.pill(statusTone(r.validation_status))}>{r.validation_status}</span>
                  </td>
                  <td style={{ ...s.td, maxWidth: 480 }}>
                    {r.validation_errors.map((issue, i) => (
                      <div key={i} style={{ marginBottom: 4 }}>
                        <span style={{ ...s.mono, color: T.faint, marginRight: 6 }}>{issue.field}</span>
                        {issue.message}
                      </div>
                    ))}
                  </td>
                  <td style={{ ...s.td, ...s.mono, color: T.muted, fontSize: 11.5, maxWidth: 300 }}>
                    {Object.entries(r.raw_json)
                      .filter(([, v]) => String(v).trim() !== '')
                      .slice(0, 5)
                      .map(([k, v]) => `${k}: ${v}`)
                      .join('  ·  ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <button
          type="button"
          onClick={() => void commit()}
          disabled={busy || blocking > 0}
          style={busy || blocking > 0 ? s.btnDisabled : s.btnPrimary}
        >
          Commit batch
        </button>
        {blocking > 0 ? (
          <span style={{ fontSize: 12.5, color: T.clay }}>
            {blocking} row{blocking === 1 ? '' : 's'} cannot be imported as they stand. Fix them in the
            file and upload again, or roll this batch back.
          </span>
        ) : (
          <span style={{ fontSize: 12.5, color: T.muted }}>
            Leads will land in the unassigned pool. Nothing is assigned automatically.
          </span>
        )}
      </section>
    </main>
  );
}

function Figure({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div>
      <div style={{ ...s.mono, fontSize: 22, color: tone }}>{value}</div>
      <div style={{ fontSize: 11, color: T.muted, textTransform: 'uppercase', letterSpacing: '1px' }}>
        {label}
      </div>
    </div>
  );
}
