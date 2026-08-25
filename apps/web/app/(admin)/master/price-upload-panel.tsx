'use client';

import { useState } from 'react';
import { api, ApiError } from '../../../lib/api';
import { s, T } from '../../../lib/ui';

/**
 * Bulk Shopify price upload.
 *
 * WHY THIS EXISTS. The client's Shopify price list changes often, and confirming
 * prices one product at a time means retyping the whole catalogue every time it
 * moves. Nobody sustains that, and the failure is silent: prices go stale,
 * `company_base_value` is computed from an old number, and every rep's credit on
 * those products is quietly wrong.
 *
 * TWO STEPS, ALWAYS. Preview then apply, and the preview is not decoration. The
 * one-at-a-time screen has an admin looking at one number against one MRP; a file
 * upload has an admin looking at a filename. The diff - every from, every to,
 * every percentage - is the only moment a tenfold typo is visible to a human
 * before it changes what people are paid.
 *
 * Paste is the primary input rather than a file picker, because the admin's price
 * list lives in a spreadsheet and copying two columns out of it is fewer steps
 * than exporting a CSV. The file picker is there for whoever prefers it.
 */

interface Verdict {
  kind: 'ACCEPTED' | 'UNCHANGED' | 'REJECTED';
  skuCode: string;
  productName?: string;
  from?: string | null;
  to?: string;
  changePercent?: string | null;
  warning?: string;
  reason?: string;
}

interface Plan {
  verdicts: Verdict[];
  accepted: number;
  unchanged: number;
  rejected: number;
  needsAcknowledgement: number;
}

interface ApplyResult extends Plan {
  applied: number;
  stillUnconfirmed: number;
  credit?: { completed: number; creditWritten: string; needsDecision: number; stillBlocked: number };
}

/**
 * Two columns: product code, price. Tabs or commas, header row optional.
 *
 * Deliberately forgiving about the SHAPE and strict about the CONTENT: a pasted
 * spreadsheet column arrives tab-separated, a saved CSV arrives comma-separated,
 * and rejecting one of those would just make the admin do format conversion by
 * hand. What the price actually IS gets validated on the server, once, where the
 * authority for a money figure belongs.
 */
function parseRows(text: string): { skuCode: string; basePrice: string }[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\t|,/).map((c) => c.trim()))
    .filter((cells) => cells.length >= 2)
    // Drop a header row if there is one. Checked by whether the second column
    // looks like a number, not by matching header names - the client's files use
    // whatever wording they used that month.
    .filter((cells, i) => !(i === 0 && !/^\d/.test(cells[1] ?? '')))
    .map((cells) => ({ skuCode: cells[0] ?? '', basePrice: cells[1] ?? '' }));
}

export function PriceUploadPanel({ onApplied }: { onApplied: () => void }) {
  const [text, setText] = useState('');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rows = parseRows(text);

  async function preview() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await api.post<Plan & { ok: boolean }>('/master/skus/price-upload/preview', { rows });
      setPlan(r);
      setAcknowledged(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That file could not be read.');
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<ApplyResult & { ok: boolean }>('/master/skus/price-upload/apply', {
        rows,
        acknowledgeWarnings: acknowledged,
      });
      setResult(r);
      setPlan(null);
      setText('');
      onApplied();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Those prices could not be applied.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section style={s.card}>
      <div style={s.cardHead}>
        <span>Upload a price list</span>
        <span style={s.pill(rows.length > 0 ? 'flat' : 'warn')}>{rows.length} row(s) read</span>
      </div>

      <p style={{ ...s.sub, fontSize: 13 }}>
        Paste two columns from your price list — product code, then base price. Tabs or commas both
        work, and a header row is fine. Nothing is saved until you have seen what it would change.
      </p>

      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setPlan(null);
          setResult(null);
        }}
        rows={6}
        spellCheck={false}
        placeholder={'BC-001\t899\nSK-002\t849'}
        style={{ ...s.input, ...s.mono, width: '100%', marginBottom: 10, minHeight: 110 }}
      />

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          type="file"
          accept=".csv,.txt,text/csv,text/plain"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            setText(await file.text());
            setPlan(null);
            setResult(null);
          }}
          style={{ fontSize: 12 }}
        />
        <button
          type="button"
          onClick={preview}
          disabled={busy || rows.length === 0}
          style={busy || rows.length === 0 ? s.btnDisabled : s.btn}
        >
          {busy ? 'Checking…' : 'Check what this would change'}
        </button>
      </div>

      {error && (
        <p role="alert" style={{ color: T.clay, fontSize: 13 }}>
          {error}
        </p>
      )}

      {plan && (
        <div style={{ marginTop: 14 }}>
          <p style={{ ...s.sub, fontSize: 13, marginBottom: 8 }}>
            <strong>{plan.accepted}</strong> to change · <strong>{plan.unchanged}</strong> already
            correct · <strong>{plan.rejected}</strong> rejected
          </p>

          <div style={{ overflowX: 'auto' }}>
            <table style={s.table}>
              <thead>
                <tr>
                  {['', 'Product', 'Now', 'New', 'Change', 'Note'].map((h) => (
                    <th key={h} style={s.th}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {plan.verdicts.map((v, i) => (
                  <tr key={`${v.skuCode}-${i}`}>
                    <td style={s.td}>
                      {/* The word, never the colour alone. */}
                      <span
                        style={{
                          ...s.pill('flat'),
                          fontSize: 10,
                          border: `1px solid ${v.kind === 'REJECTED' ? T.clay : v.kind === 'ACCEPTED' ? T.vine : T.faint}`,
                          color: v.kind === 'REJECTED' ? T.clay : v.kind === 'ACCEPTED' ? T.vine : T.muted,
                        }}
                      >
                        {v.kind === 'ACCEPTED' ? 'change' : v.kind === 'UNCHANGED' ? 'same' : 'rejected'}
                      </span>
                    </td>
                    <td style={s.td}>
                      <span style={s.mono}>{v.skuCode}</span>
                      {v.productName && <span style={{ color: T.muted }}> {v.productName}</span>}
                    </td>
                    <td style={{ ...s.td, ...s.mono }}>{v.from ?? '—'}</td>
                    <td style={{ ...s.td, ...s.mono }}>{v.to ?? '—'}</td>
                    <td style={{ ...s.td, ...s.mono }}>{v.changePercent ? `${v.changePercent}%` : '—'}</td>
                    <td style={{ ...s.td, fontSize: 12, color: v.kind === 'REJECTED' ? T.clay : T.muted }}>
                      {v.reason ?? v.warning ?? ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {plan.needsAcknowledgement > 0 && (
            <label
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'flex-start',
                marginTop: 12,
                fontSize: 13,
                color: T.clay,
              }}
            >
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
                style={{ marginTop: 3 }}
              />
              <span>
                {plan.needsAcknowledgement} price(s) change by more than half. These decide what
                every rep earns on those products — I have checked them and they are correct.
              </span>
            </label>
          )}

          <p style={{ marginTop: 12 }}>
            <button
              type="button"
              onClick={apply}
              disabled={busy || plan.accepted === 0 || (plan.needsAcknowledgement > 0 && !acknowledged)}
              style={
                busy || plan.accepted === 0 || (plan.needsAcknowledgement > 0 && !acknowledged)
                  ? s.btnDisabled
                  : s.btnPrimary
              }
            >
              Apply {plan.accepted} price change(s)
            </button>
          </p>
        </div>
      )}

      {result && (
        <div style={s.notice('ok')}>
          <p style={{ margin: 0 }}>
            {result.applied} price(s) applied. {result.stillUnconfirmed} product(s) still have no
            confirmed price.
          </p>
          {result.credit && (
            <p style={{ margin: '6px 0 0' }}>
              {/*
                The half of the promise that was missing. A rep booking against an
                unconfirmed price is told her credit will follow (D-124); this is
                the sentence that says it did.
              */}
              {result.credit.completed > 0
                ? `₹${result.credit.creditWritten} of pending rep credit has now been worked out and recorded.`
                : 'No orders were waiting on these prices.'}
              {result.credit.needsDecision > 0 && (
                <>
                  {' '}
                  <strong>
                    {result.credit.needsDecision} order(s) were already delivered while their price
                    was unconfirmed.
                  </strong>{' '}
                  Those need a decision about which month to pay them in — they have not been
                  credited automatically.
                </>
              )}
              {result.credit.stillBlocked > 0 && (
                <> {result.credit.stillBlocked} order(s) are still waiting on other prices.</>
              )}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
