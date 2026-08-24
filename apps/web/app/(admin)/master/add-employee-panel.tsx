'use client';

import { useState } from 'react';
import { api, ApiError } from '../../../lib/api';
import { s, T } from '../../../lib/ui';

/**
 * Adding someone to the roster.
 *
 * WHY IT EXISTS. `roster-rules.ts` already said admins manage the roster here and
 * that the seeded people are "a starting point rather than a claim" - that was how
 * O-01 was answered, as a mechanism instead of a list, because rosters change.
 * Offboarding was built. Onboarding was not, so the only roster this system could
 * ever have was the one in a CSV, and a new joiner had no way in.
 *
 * THE PASSWORD IS SHOWN ONCE. There is no reset flow in v1, so it is displayed
 * until the admin dismisses it and is never readable again - only its Argon2id
 * hash is stored. The screen says so plainly rather than letting an admin close
 * the panel and find out later.
 *
 * WHAT THIS FORM DOES NOT OFFER, deliberately: a monthly target, and (unless you
 * are the owner) a role. An admin who could set targets could set their own
 * incentive; an admin who could set roles could make themselves an owner. The API
 * refuses both, and a form offering a field the server will reject is a worse
 * experience than one that never showed it.
 */

interface Created {
  empCode: string;
  fullName: string;
  role: string;
  temporaryPassword: string;
  mustEnrolTotp: boolean;
}

export function AddEmployeePanel({ isOwner, onAdded }: { isOwner: boolean; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [empCode, setEmpCode] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'EMPLOYEE' | 'ADMIN'>('EMPLOYEE');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<Created & { ok: boolean }>('/master/roster/add', {
        empCode,
        fullName,
        email,
        role,
      });
      setCreated(r);
      setEmpCode('');
      setFullName('');
      setEmail('');
      setRole('EMPLOYEE');
      onAdded();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That person could not be added.');
    } finally {
      setBusy(false);
    }
  }

  const ready = empCode.trim() && fullName.trim() && email.trim();

  return (
    <div style={{ marginTop: 14, borderTop: `1px solid ${T.line}`, paddingTop: 14 }}>
      {!open && !created && (
        <button type="button" style={s.btn} onClick={() => setOpen(true)}>
          Add someone to the roster
        </button>
      )}

      {created && (
        <div style={s.notice('ok')}>
          <p style={{ margin: 0 }}>
            <strong>
              {created.fullName} ({created.empCode})
            </strong>{' '}
            can now sign in as {created.role === 'ADMIN' ? 'an admin' : 'a rep'}.
          </p>
          <p style={{ margin: '8px 0 4px' }}>Temporary password — copy it now, it is not shown again:</p>
          <p
            style={{
              ...s.mono,
              fontSize: 15,
              background: T.paper,
              border: `1px solid ${T.line}`,
              padding: '8px 10px',
              borderRadius: 4,
              margin: 0,
              wordBreak: 'break-all',
            }}
          >
            {created.temporaryPassword}
          </p>
          {created.mustEnrolTotp && (
            <p style={{ margin: '8px 0 0', fontSize: 13 }}>
              They will be asked to link an authenticator app the first time they sign in, because
              admins need a 6-digit code.
            </p>
          )}
          <p style={{ margin: '10px 0 0' }}>
            <button type="button" style={s.btn} onClick={() => setCreated(null)}>
              Done
            </button>
          </p>
        </div>
      )}

      {open && !created && (
        <div style={{ display: 'grid', gap: 10, maxWidth: 460 }}>
          <div>
            <label style={s.label} htmlFor="empCode">
              Employee code
            </label>
            <input
              id="empCode"
              value={empCode}
              onChange={(e) => setEmpCode(e.target.value.toUpperCase())}
              placeholder="EMP-010"
              style={{ ...s.input, ...s.mono }}
            />
          </div>

          <div>
            <label style={s.label} htmlFor="fullName">
              Full name
            </label>
            <input id="fullName" value={fullName} onChange={(e) => setFullName(e.target.value)} style={s.input} />
          </div>

          <div>
            <label style={s.label} htmlFor="newEmail">
              Email — this is what they sign in with
            </label>
            <input
              id="newEmail"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@razorveda.local"
              style={s.input}
            />
          </div>

          {/* Only the owner sees this at all. See the note at the top of the file. */}
          {isOwner && (
            <div>
              <label style={s.label} htmlFor="newRole">
                Role
              </label>
              <select
                id="newRole"
                value={role}
                onChange={(e) => setRole(e.target.value as 'EMPLOYEE' | 'ADMIN')}
                style={s.input}
              >
                <option value="EMPLOYEE">Rep — sees only her own leads</option>
                <option value="ADMIN">Admin — uploads, assigns, reports</option>
              </select>
            </div>
          )}

          <p style={{ ...s.sub, fontSize: 12, margin: 0 }}>
            Their monthly target starts at zero. Only the owner can set targets, on this same screen.
          </p>

          {error && (
            <p role="alert" style={{ color: T.clay, fontSize: 13, margin: 0 }}>
              {error}
            </p>
          )}

          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={submit}
              disabled={busy || !ready}
              style={busy || !ready ? s.btnDisabled : s.btnPrimary}
            >
              {busy ? 'Adding…' : 'Add to roster'}
            </button>
            <button type="button" style={s.btn} onClick={() => { setOpen(false); setError(null); }}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
