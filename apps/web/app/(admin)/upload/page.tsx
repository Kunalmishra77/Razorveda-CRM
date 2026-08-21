'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api, ApiError, type Batch, type UploadResponse } from '../../../lib/api';
import { s, statusTone, T } from '../../../lib/ui';

/**
 * Upload Centre (docs/07 module 1).
 *
 * Nine channel boxes, batch history, rollback. "Drag the day's file into the
 * matching box. That is the entire manual action."
 */

const CHANNELS = [
  { code: 'SHOPIFY', label: 'Shopify Orders' },
  { code: 'META_ADS', label: 'Meta Ads Leads' },
  { code: 'WEB_WHATSAPP', label: 'Website WhatsApp' },
  { code: 'ADD_TO_CART', label: 'Add to Cart' },
  { code: 'WEB_CALL', label: 'Website Call' },
  { code: 'WA_CAMPAIGN', label: 'WhatsApp Campaign' },
  { code: 'DELIVERED_REPEAT', label: 'Delivered / Repeat' },
  { code: 'RTO_RECOVERY', label: 'RTO Recovery' },
  { code: 'NC_REFUSED', label: 'NC / Refused' },
] as const;

export default function UploadCentre() {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [result, setResult] = useState<UploadResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await api.get<{ batches: Batch[] }>('/ingestion/batches');
      setBatches(r.batches);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load batch history.');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function send(sourceCode: string, file: File) {
    setBusy(sourceCode);
    setResult(null);
    setError(null);
    try {
      const contentBase64 = await toBase64(file);
      const r = await api.post<UploadResponse>('/ingestion/upload', {
        sourceCode,
        fileName: file.name,
        contentBase64,
      });
      setResult(r);
      await refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That upload failed.');
    } finally {
      setBusy(null);
    }
  }

  async function rollback(batchId: string) {
    const reason = window.prompt('Why are you rolling this batch back? It goes on the audit trail.');
    if (!reason) return; // a rollback with no reason is refused by the API anyway
    try {
      const r = await api.post<{ ok: boolean; message?: string }>(
        `/ingestion/batches/${batchId}/rollback`,
        { reason },
      );
      if (!r.ok) setError(r.message ?? 'That batch could not be rolled back.');
      await refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That rollback failed.');
    }
  }

  return (
    <main style={s.page}>
      <h1 style={s.h1}>Upload Centre</h1>
      <p style={s.sub}>
        Drop the day&apos;s file into the matching channel. Everything else is automatic until the
        exception review.
      </p>

      {error && <div role="alert" style={s.notice('bad')}>{error}</div>}
      {result && <UploadOutcome result={result} />}

      <section style={s.card} aria-label="Channels">
        <div style={s.cardHead}><span>Channels</span><span>9</span></div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(210px,1fr))', gap: 10 }}>
          {CHANNELS.map((c) => (
            <DropBox key={c.code} code={c.code} label={c.label} busy={busy === c.code} onFile={send} />
          ))}
        </div>
      </section>

      <section style={s.card} aria-label="Batch history">
        <div style={s.cardHead}><span>Batch history</span><span>{batches.length}</span></div>
        {batches.length === 0 ? (
          // Empty states are invitations (docs/07 §5).
          <p style={s.empty}>No files uploaded yet. Drop one into a channel above to start.</p>
        ) : (
          <table style={s.table}>
            <thead>
              <tr>
                {['File', 'Channel', 'Status', 'Rows', 'Exceptions', 'Uploaded', ''].map((h) => (
                  <th key={h} scope="col" style={s.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {batches.map((b) => (
                <tr key={b.batch_id}>
                  <td style={s.td}>{b.file_name}</td>
                  <td style={s.td}>{b.source}</td>
                  <td style={s.td}>
                    <span style={s.pill(statusTone(b.status))}>{b.status}</span>
                  </td>
                  <td style={{ ...s.td, ...s.mono, textAlign: 'right' }}>{b.row_count}</td>
                  <td style={{ ...s.td, ...s.mono, textAlign: 'right' }}>
                    {Number(b.exceptions) > 0 ? (
                      <Link href={`/batches/${b.batch_id}`} style={{ color: T.brass }}>
                        {b.exceptions} to review
                      </Link>
                    ) : (
                      <span style={{ color: T.faint }}>0</span>
                    )}
                  </td>
                  <td style={{ ...s.td, ...s.mono, color: T.muted }}>
                    {new Date(b.created_at).toLocaleString('en-GB')}
                  </td>
                  <td style={s.td}>
                    <Link href={`/batches/${b.batch_id}`} style={{ ...s.btn, textDecoration: 'none' }}>
                      Open
                    </Link>
                    {b.status === 'COMMITTED' && (
                      <button type="button" onClick={() => void rollback(b.batch_id)} style={{ ...s.btn, marginLeft: 6 }}>
                        Roll back
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}

function UploadOutcome({ result }: { result: UploadResponse }) {
  if (result.status === 'SHIFTED') {
    return (
      <div role="alert" style={s.notice('bad')}>
        <strong>Columns look shifted — nothing was imported.</strong>
        {'\n\n'}
        {result.message}
      </div>
    );
  }
  if (result.status === 'DUPLICATE') {
    return <div role="alert" style={s.notice('warn')}>{result.message}</div>;
  }
  if (!result.ok) {
    return <div role="alert" style={s.notice('bad')}>{result.message ?? 'That upload failed.'}</div>;
  }
  return (
    <div style={s.notice(result.exceptions ? 'warn' : 'ok')}>
      <strong>{result.rows} rows read.</strong>{' '}
      {result.clean} clean, {result.exceptions} needing a look.{' '}
      {result.exceptions ? (
        <Link href={`/batches/${result.batchId}`} style={{ color: T.brass }}>
          Review {result.exceptions} exception{result.exceptions === 1 ? '' : 's'} →
        </Link>
      ) : (
        <Link href={`/batches/${result.batchId}`} style={{ color: T.vine }}>Commit the batch →</Link>
      )}
    </div>
  );
}

function DropBox({
  code, label, busy, onFile,
}: {
  code: string;
  label: string;
  busy: boolean;
  onFile: (code: string, file: File) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const file = e.dataTransfer.files[0];
        if (file) onFile(code, file);
      }}
      style={{
        border: `1px ${over ? 'solid' : 'dashed'} ${over ? T.brass : T.line}`,
        borderRadius: 3,
        padding: '14px 12px',
        background: over ? '#FBF7EC' : T.card,
        textAlign: 'center',
      }}
    >
      <div style={{ fontSize: 13, marginBottom: 2 }}>{label}</div>
      <div style={{ ...s.mono, color: T.faint, fontSize: 10, marginBottom: 8 }}>{code}</div>
      <button
        type="button"
        onClick={() => input.current?.click()}
        disabled={busy}
        style={busy ? s.btnDisabled : s.btn}
      >
        {busy ? 'Reading…' : 'Choose file'}
      </button>
      <input
        ref={input}
        type="file"
        accept=".csv,.xlsx,.xls"
        style={s.srOnly}
        aria-label={`Upload a file for ${label}`}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(code, file);
          e.target.value = '';
        }}
      />
    </div>
  );
}

/** The API takes base64. Real multipart streaming lands with the 20 MB limit. */
function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}
