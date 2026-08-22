'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../../../lib/api';
import { s, T } from '../../../../lib/ui';

/**
 * Order Entry with the live credit preview (docs/07 §4).
 *
 * "The rep sees exactly how they are scored, as they sell."
 *
 * That is the answer to F7. The 31% attribution leak survived for months because
 * nobody could see the subtraction happening — 16 of 52 Shopify rows credited the
 * full order value because a human forgot it. Here the split is on screen while
 * she sells, and she never types the company base at all.
 */

interface Sku {
  sku_id: string;
  sku_code: string;
  product_name: string;
  mrp: string;
  product_line: string;
  shopify_base_price: string | null;
  shopify_base_price_confirmed: boolean;
}

interface Line {
  skuId: string;
  quantity: number;
  unitPrice: string;
  isUpsell: boolean;
}

interface Preview {
  creditKnown: boolean;
  companyBaseValue: string;
  employeeCreditedValue: string;
  ruleApplied: string;
  note: string;
}

export function OrderEntry({ leadId, onBooked }: { leadId: string; onBooked: () => void }) {
  const [skus, setSkus] = useState<Sku[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  const [prepaid, setPrepaid] = useState('0');
  const [cod, setCod] = useState('0');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [booked, setBooked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<{ skus: Sku[] }>('/orders/skus').then((r) => setSkus(r.skus)).catch(() => setSkus([]));
  }, []);

  const orderValue = lines.reduce((sum, l) => sum + Number(l.unitPrice || 0) * l.quantity, 0);

  const refreshPreview = useCallback(async () => {
    if (lines.length === 0) { setPreview(null); return; }
    try {
      const r = await api.post<Preview & { ok: boolean }>('/orders/preview', {
        leadId,
        lines: lines.map((l) => ({ skuId: l.skuId, quantity: l.quantity, unitPrice: l.unitPrice || '0' })),
        prepaidAmount: prepaid || '0',
        codAmount: cod || '0',
        upsellSkuIds: lines.filter((l) => l.isUpsell).map((l) => l.skuId),
      });
      if (r.ok) setPreview(r);
    } catch { /* preview is advisory; a failure must not block selling */ }
  }, [leadId, lines, prepaid, cod]);

  useEffect(() => { void refreshPreview(); }, [refreshPreview]);

  function addLine(skuId: string) {
    const sku = skus.find((x) => x.sku_id === skuId);
    if (!sku) return;
    setLines((ls) => [
      ...ls,
      // First line is the cart; anything after it the rep added. She can change
      // it — this is a sensible default, not a rule.
      { skuId, quantity: 1, unitPrice: sku.mrp, isUpsell: ls.length > 0 },
    ]);
  }

  async function book() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ ok: boolean; orderNumber?: string; message?: string }>('/orders', {
        leadId,
        lines: lines.map((l) => ({ skuId: l.skuId, quantity: l.quantity, unitPrice: l.unitPrice || '0' })),
        prepaidAmount: prepaid || '0',
        codAmount: cod || '0',
        upsellSkuIds: lines.filter((l) => l.isUpsell).map((l) => l.skuId),
      });
      if (!r.ok) { setError(r.message ?? 'That order could not be booked.'); return; }
      setBooked(r.orderNumber ?? 'booked');
      setLines([]); setPrepaid('0'); setCod('0'); setPreview(null);
      onBooked();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That order could not be booked.');
    } finally {
      setBusy(false);
    }
  }

  const paid = Number(prepaid || 0) + Number(cod || 0);
  const balanced = Math.abs(paid - orderValue) < 0.005 && orderValue > 0;

  if (booked) {
    return (
      <section style={s.card}>
        <div style={s.notice('ok')}>
          Order <strong>{booked}</strong> booked. It shows as pending until dispatch, and your credit
          realises when it is delivered.
        </div>
        <button type="button" style={s.btn} onClick={() => setBooked(null)}>Book another</button>
      </section>
    );
  }

  return (
    <section style={s.card} aria-label="Order entry">
      <div style={s.cardHead}><span>Book an order</span><span /></div>

      {error && <div role="alert" style={s.notice('bad')}>{error}</div>}

      <label style={s.label} htmlFor="sku">Add a product</label>
      <select
        id="sku" value="" onChange={(e) => { addLine(e.target.value); e.target.value = ''; }}
        style={{ ...s.input, marginBottom: 12 }}
      >
        <option value="">Choose a product…</option>
        {skus.map((sku) => (
          <option key={sku.sku_id} value={sku.sku_id}>
            {sku.product_name} — ₹{Number(sku.mrp).toLocaleString('en-IN')} ({sku.product_line})
          </option>
        ))}
      </select>

      {lines.length === 0 ? (
        <p style={s.empty}>No products yet. Add what she is buying.</p>
      ) : (
        <table style={{ ...s.table, marginBottom: 12 }}>
          <thead>
            <tr>{['Product', 'Qty', 'Price', 'Line total', 'Upsell', ''].map((h) => (
              <th key={h} scope="col" style={s.th}>{h}</th>
            ))}</tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const sku = skus.find((x) => x.sku_id === l.skuId);
              return (
                <tr key={i}>
                  <td style={s.td}>{sku?.product_name}</td>
                  <td style={s.td}>
                    <input
                      type="number" min={1} max={99} value={l.quantity}
                      onChange={(e) => setLines((ls) => ls.map((x, j) => j === i ? { ...x, quantity: Math.max(1, Number(e.target.value)) } : x))}
                      style={{ ...s.input, ...s.mono, width: 62 }}
                    />
                  </td>
                  <td style={s.td}>
                    <input
                      value={l.unitPrice}
                      onChange={(e) => setLines((ls) => ls.map((x, j) => j === i ? { ...x, unitPrice: e.target.value.replace(/[^\d.]/g, '') } : x))}
                      style={{ ...s.input, ...s.mono, width: 92 }}
                    />
                  </td>
                  <td style={{ ...s.td, ...s.mono, textAlign: 'right' }}>
                    ₹{(Number(l.unitPrice || 0) * l.quantity).toLocaleString('en-IN')}
                  </td>
                  <td style={s.td}>
                    <input
                      type="checkbox" checked={l.isUpsell}
                      onChange={(e) => setLines((ls) => ls.map((x, j) => j === i ? { ...x, isUpsell: e.target.checked } : x))}
                      aria-label={`${sku?.product_name} was added by me`}
                    />
                  </td>
                  <td style={s.td}>
                    <button type="button" style={s.btn} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                      Remove
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {/* Two numeric fields, never one free-text box. The client's Payment Mode
          column has 121 variants and the prepaid ratio — the strongest RTO
          predictor available — is unmeasurable because of it (F5). */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 6, flexWrap: 'wrap' }}>
        <div>
          <label style={s.label} htmlFor="prepaid">Prepaid ₹</label>
          <input id="prepaid" value={prepaid} onChange={(e) => setPrepaid(e.target.value.replace(/[^\d.]/g, ''))} style={{ ...s.input, ...s.mono, width: 120 }} />
        </div>
        <div>
          <label style={s.label} htmlFor="cod">COD ₹</label>
          <input id="cod" value={cod} onChange={(e) => setCod(e.target.value.replace(/[^\d.]/g, ''))} style={{ ...s.input, ...s.mono, width: 120 }} />
        </div>
        <div style={{ alignSelf: 'flex-end', paddingBottom: 8, fontSize: 12.5, color: balanced ? T.vine : T.muted }}>
          {orderValue > 0 && (balanced
            ? 'Payment matches the order.'
            : `₹${paid.toLocaleString('en-IN')} of ₹${orderValue.toLocaleString('en-IN')} — these must match.`)}
        </div>
      </div>

      {preview && orderValue > 0 && (
        <div style={s.notice(preview.creditKnown ? 'ok' : 'warn')} aria-live="polite">
          <div style={{ ...s.mono, fontSize: 14, marginBottom: 6 }}>
            Order ₹{orderValue.toLocaleString('en-IN')}
            {'   ·   '}Company base ₹{Number(preview.companyBaseValue).toLocaleString('en-IN')}
            {'   ·   '}
            <strong style={{ color: preview.creditKnown ? T.vine : T.brass }}>
              Your credit ₹{Number(preview.employeeCreditedValue).toLocaleString('en-IN')}
            </strong>
          </div>
          <div style={{ fontSize: 12.5, color: T.muted }}>{preview.note}</div>
        </div>
      )}

      <button
        type="button" onClick={() => void book()} disabled={busy || !balanced || lines.length === 0}
        style={busy || !balanced || lines.length === 0 ? s.btnDisabled : s.btnPrimary}
      >
        {busy ? 'Booking…' : 'Book order'}
      </button>
    </section>
  );
}
