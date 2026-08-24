'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../../lib/api';
import { s, T } from '../../../lib/ui';
import { PriceUploadPanel } from './price-upload-panel';
import { AddEmployeePanel } from './add-employee-panel';

/**
 * Master Data (docs/07 §6).
 *
 * Two things on this page are blocking real work, and they are first for that
 * reason:
 *
 *   Unconfirmed base prices. An order on a SKU with no confirmed price books
 *   normally and the rep earns NOTHING (D-124). The exception digest has been
 *   reporting this every morning with no screen to fix it on.
 *
 *   The incentive scheme. It is the proposals from docs/03 §6, so every payable
 *   figure in the month-close pack says "not approvable for payment" (O-09).
 *   Answering that used to mean sending numbers to a developer. It should mean
 *   typing them in here.
 */

interface Sku {
  sku_id: string; sku_code: string; product_name: string; product_line: string;
  mrp: string; shopify_base_price: string | null; shopify_base_price_confirmed: boolean;
  usage_days: number | null; usage_days_confirmed: boolean; confirmed_by: string | null;
}

interface Slab {
  slab_id: string; min_value: string; max_value: string | null;
  percent: string; effective_from: string; is_provisional: boolean;
}

interface Modifier {
  modifier_id: string; kind: string; threshold_min: string | null;
  threshold_max: string | null; value: string; is_provisional: boolean;
  note: string | null; product_line: string | null;
}

interface Employee {
  employee_id: string; emp_code: string; full_name: string; status: string;
  monthly_target: string | null; email: string | null; is_locked: boolean;
  live_leads: number;
}

export default function MasterDataPage() {
  const [skus, setSkus] = useState<Sku[]>([]);
  const [skuWarning, setSkuWarning] = useState<string | null>(null);
  const [slabs, setSlabs] = useState<Slab[]>([]);
  const [modifiers, setModifiers] = useState<Modifier[]>([]);
  const [schemeWarning, setSchemeWarning] = useState<string | null>(null);
  const [roster, setRoster] = useState<Employee[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [priceDraft, setPriceDraft] = useState<Record<string, string>>({});
  const [targetDraft, setTargetDraft] = useState<Record<string, string>>({});
  // Needed to decide whether the Role selector is offered at all. The API
  // refuses an admin creating an admin regardless; this keeps the form from
  // showing a field the server will reject.
  const [isOwner, setIsOwner] = useState(false);

  useEffect(() => {
    api
      .get<{ session: { role: string } }>('/auth/me')
      .then((r) => setIsOwner(r.session.role === 'OWNER'))
      .catch(() => setIsOwner(false));
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [k, i, r] = await Promise.all([
        api.get<{ skus: Sku[]; warning?: string }>('/master/skus'),
        api.get<{ slabs: Slab[]; modifiers: Modifier[]; warning?: string }>('/master/incentive'),
        api.get<{ employees: Employee[] }>('/master/roster'),
      ]);
      setSkus(k.skus);
      setSkuWarning(k.warning ?? null);
      setSlabs(i.slabs);
      setModifiers(i.modifiers);
      setSchemeWarning(i.warning ?? null);
      setRoster(r.employees);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Master data could not be loaded.');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function confirmPrice(sku: Sku) {
    const basePrice = (priceDraft[sku.sku_id] ?? '').trim();
    if (!basePrice) return;
    setError(null); setNote(null);
    try {
      const r = await api.post<{ productName: string; creditOnAnMrpSale: string; stillUnconfirmed: number }>(
        '/master/skus/confirm-price', { skuId: sku.sku_id, basePrice },
      );
      setNote(
        `${r.productName} confirmed at ₹${basePrice}. A rep selling it at MRP now earns ` +
        `₹${r.creditOnAnMrpSale}. ${r.stillUnconfirmed} product(s) still unconfirmed.`,
      );
      setPriceDraft((d) => ({ ...d, [sku.sku_id]: '' }));
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That price could not be confirmed.');
    }
  }

  async function setTarget(emp: Employee) {
    const monthlyTarget = (targetDraft[emp.employee_id] ?? '').trim();
    if (!monthlyTarget) return;
    setError(null); setNote(null);
    try {
      const r = await api.post<{ employee: string; from: string; to: string }>(
        '/master/roster/target', { employeeId: emp.employee_id, monthlyTarget },
      );
      setNote(`${r.employee}: target ₹${money(r.from)} → ₹${money(r.to)}. The change is on the audit trail.`);
      setTargetDraft((d) => ({ ...d, [emp.employee_id]: '' }));
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That target could not be saved.');
    }
  }

  const unconfirmed = skus.filter((k) => !k.shopify_base_price_confirmed);
  // Separate count, because these two block different things. An unconfirmed
  // PRICE parks the order and pays the rep nothing; an unconfirmed USAGE_DAYS
  // still schedules the reorder but stamps the rep's lead "timing estimated".
  const usageUnconfirmed = skus.filter((k) => k.usage_days !== null && !k.usage_days_confirmed);

  return (
    <main style={s.page}>
      <h1 style={s.h1}>Master Data</h1>
      <p style={s.lede}>
        The numbers the system calculates from. Everything here is audited, and the incentive
        scheme is versioned — changing a slab opens a new one with a date rather than rewriting
        history.
      </p>

      {error && <div role="alert" style={s.notice('bad')}>{error}</div>}
      {note && <div style={s.notice('ok')}>{note}</div>}

      <section style={s.card}>
        <div style={s.cardHead}>
          <span>Shopify base prices</span>
          <span style={{ color: T.muted, fontSize: 12 }}>
            {unconfirmed.length} of {skus.length} unconfirmed
          </span>
        </div>

        {skuWarning && <div style={s.notice('warn')}>{skuWarning}</div>}

        {/*
          A SEPARATE notice, because it blocks something different. An unconfirmed
          PRICE parks the order and the rep earns nothing on it. An unconfirmed
          usage_days does not block anything - the reorder is still scheduled - but
          the date is a guess reverse-engineered from past orders (O-03), and since
          the repeat engine started running daily those guesses decide which
          customer a rep rings on which day. Her lead says "timing estimated" until
          somebody here vouches for the number.
        */}
        {usageUnconfirmed.length > 0 && (
          <div style={s.notice('warn')}>
            {usageUnconfirmed.length} product(s) have an <strong>estimated</strong> repeat interval.
            Reorders are still scheduled from them, and every lead they produce is marked
            &ldquo;timing estimated&rdquo; on the rep&rsquo;s worklist. Enter the real number of days
            the pack lasts to remove the caveat.
          </div>
        )}

        {skus.length === 0 ? (
          <p style={s.empty}>No active products.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={s.table}>
              <thead>
                <tr>{['Product', 'Line', 'MRP', 'Base price', 'Rep earns at MRP', 'Confirm'].map((h) => (
                  <th key={h} scope="col" style={s.th}>{h}</th>))}</tr>
              </thead>
              <tbody>
                {/* Unconfirmed first — the API orders by confirmed status, so the
                    work to do is at the top without the page sorting anything. */}
                {skus.map((k) => (
                  <tr key={k.sku_id}>
                    <td style={s.td}>
                      {k.product_name}
                      <span style={{ ...s.mono, color: T.muted, fontSize: 11, marginLeft: 6 }}>{k.sku_code}</span>
                    </td>
                    <td style={s.td}>{k.product_line}</td>
                    <td style={{ ...s.td, ...s.mono, textAlign: 'right' }}>₹{money(k.mrp)}</td>
                    <td style={{ ...s.td, ...s.mono, textAlign: 'right' }}>
                      {k.shopify_base_price_confirmed ? (
                        <span>₹{money(k.shopify_base_price ?? '0')}</span>
                      ) : (
                        <span style={s.pill('warn')}>not confirmed</span>
                      )}
                    </td>
                    <td style={{ ...s.td, ...s.mono, textAlign: 'right' }}>
                      {k.shopify_base_price_confirmed
                        ? `₹${money(String(Number(k.mrp) - Number(k.shopify_base_price ?? 0)))}`
                        : <span style={{ color: T.brass }}>nothing</span>}
                    </td>
                    <td style={s.td}>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <input
                          value={priceDraft[k.sku_id] ?? ''}
                          onChange={(e) => setPriceDraft((d) => ({ ...d, [k.sku_id]: e.target.value.replace(/[^\d.]/g, '') }))}
                          placeholder={k.shopify_base_price ?? '0.00'}
                          aria-label={`Base price for ${k.product_name}`}
                          style={{ ...s.input, ...s.mono, width: 96 }}
                        />
                        <button
                          type="button" style={s.btn}
                          disabled={!(priceDraft[k.sku_id] ?? '').trim()}
                          onClick={() => void confirmPrice(k)}
                        >
                          {k.shopify_base_price_confirmed ? 'Change' : 'Confirm'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p style={s.hint}>
          The base price is what the company committed before the rep touched the order. Her credit
          is the order value minus it. Confirming a price does not retro-credit orders already
          booked without one — that is a separate, deliberate step.
        </p>
      </section>

      {/*
        Directly after the per-product table, because it does the same job at a
        different scale: that table is for correcting one price, this is for the
        list moving. Both end in the same place - a confirmed price - and both now
        complete any rep credit that was waiting on it.
      */}
      <PriceUploadPanel onApplied={load} />

      <section style={s.card}>
        <div style={s.cardHead}>
          <span>Incentive scheme</span>
          <span style={s.pill(schemeWarning ? 'warn' : 'ok')}>
            {schemeWarning ? 'provisional' : 'confirmed'}
          </span>
        </div>

        {schemeWarning && <div style={s.notice('warn')}>{schemeWarning}</div>}

        <table style={{ ...s.table, marginBottom: 16 }}>
          <thead><tr>{['From', 'To', 'Rate', 'Effective', 'Status'].map((h) => (
            <th key={h} scope="col" style={s.th}>{h}</th>))}</tr></thead>
          <tbody>
            {slabs.map((sl) => (
              <tr key={sl.slab_id}>
                <td style={{ ...s.td, ...s.mono, textAlign: 'right' }}>₹{money(sl.min_value)}</td>
                <td style={{ ...s.td, ...s.mono, textAlign: 'right' }}>
                  {sl.max_value ? `₹${money(sl.max_value)}` : 'and above'}
                </td>
                <td style={{ ...s.td, ...s.mono, textAlign: 'right' }}>{sl.percent}%</td>
                <td style={{ ...s.td, ...s.mono }}>{String(sl.effective_from).slice(0, 10)}</td>
                <td style={s.td}>
                  <span style={s.pill(sl.is_provisional ? 'warn' : 'ok')}>
                    {sl.is_provisional ? 'proposal' : 'confirmed'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <table style={s.table}>
          <thead><tr>{['Modifier', 'Applies when', 'Value', 'Status'].map((h) => (
            <th key={h} scope="col" style={s.th}>{h}</th>))}</tr></thead>
          <tbody>
            {modifiers.map((m) => (
              <tr key={m.modifier_id}>
                <td style={s.td}>{humanKind(m.kind)}{m.product_line ? ` — ${m.product_line}` : ''}</td>
                <td style={s.td}>{band(m)}</td>
                <td style={{ ...s.td, ...s.mono, textAlign: 'right' }}>{m.value}</td>
                <td style={s.td}>
                  <span style={s.pill(m.is_provisional ? 'warn' : 'ok')}>
                    {m.is_provisional ? 'proposal' : 'confirmed'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <p style={s.hint}>
          Editing a slab or modifier does not overwrite it — it closes the old row and opens a new
          one from a date you choose, so a past month recomputes to the scheme that was in force
          then. Marking the scheme confirmed is what removes &ldquo;not approvable for payment&rdquo;
          from every incentive statement.
        </p>
      </section>

      <section style={s.card}>
        <div style={s.cardHead}><span>Roster and targets</span><span /></div>
        <table style={s.table}>
          <thead><tr>{['Rep', 'Status', 'Live leads', 'Monthly target', 'Change'].map((h) => (
            <th key={h} scope="col" style={s.th}>{h}</th>))}</tr></thead>
          <tbody>
            {roster.map((e) => (
              <tr key={e.employee_id}>
                <td style={s.td}>
                  {e.full_name}
                  <span style={{ ...s.mono, color: T.muted, fontSize: 11, marginLeft: 6 }}>{e.emp_code}</span>
                </td>
                <td style={s.td}>
                  <span style={s.pill(e.status === 'ACTIVE' ? 'ok' : 'flat')}>{e.status.toLowerCase()}</span>
                  {e.is_locked && <span style={{ ...s.pill('bad'), marginLeft: 6 }}>locked</span>}
                </td>
                <td style={{ ...s.td, ...s.mono, textAlign: 'right' }}>{e.live_leads}</td>
                <td style={{ ...s.td, ...s.mono, textAlign: 'right' }}>₹{money(e.monthly_target ?? '0')}</td>
                <td style={s.td}>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      value={targetDraft[e.employee_id] ?? ''}
                      onChange={(ev) => setTargetDraft((d) => ({ ...d, [e.employee_id]: ev.target.value.replace(/[^\d.]/g, '') }))}
                      placeholder={e.monthly_target ?? '0'}
                      aria-label={`Monthly target for ${e.full_name}`}
                      style={{ ...s.input, ...s.mono, width: 110 }}
                    />
                    <button
                      type="button" style={s.btn}
                      disabled={!(targetDraft[e.employee_id] ?? '').trim()}
                      onClick={() => void setTarget(e)}
                    >Set</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p style={s.hint}>
          Targets are delivery targets. The RTO-adjusted booking figure derived from them is built
          and shown in Reports as a comparison, but is not yet in force.
        </p>

        {/*
          Inside the roster card rather than a card of its own: adding someone and
          seeing who is already there are the same task, and an admin looking for
          "where do I add the new girl" looks at the list of people first.
        */}
        <AddEmployeePanel isOwner={isOwner} onAdded={load} />
      </section>
    </main>
  );
}

const money = (v: string): string =>
  Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const humanKind = (kind: string): string =>
  ({
    DELIVERY_QUALITY: 'Delivery quality multiplier',
    PREPAID_BONUS: 'Prepaid bonus',
    PRODUCT_SPIF: 'Product SPIF',
    REPEAT_BONUS: 'Repeat-customer bonus',
  })[kind] ?? kind;

function band(m: Modifier): string {
  const pct = (v: string | null) => (v === null ? null : `${(Number(v) * 100).toFixed(0)}%`);
  if (m.kind === 'DELIVERY_QUALITY') {
    return m.threshold_max ? `RTO ${pct(m.threshold_min)}–${pct(m.threshold_max)}` : `RTO over ${pct(m.threshold_min)}`;
  }
  if (m.kind === 'PREPAID_BONUS') return `Prepaid ratio over ${pct(m.threshold_min)}`;
  if (m.kind === 'REPEAT_BONUS') return `Buyer Fq ${m.threshold_min ?? '?'} or more`;
  return m.note ?? '—';
}
