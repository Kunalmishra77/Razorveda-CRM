import { describe, it, expect } from 'vitest';
import type { PoolClient } from 'pg';
import { APP_ROLE, applyRlsContext, type RlsSession } from '../src/db/rls-context.js';

/**
 * Unit tests for the RLS context. These do NOT prove isolation — only a live
 * database can do that, and those are the eight tests in test/rls/isolation.test.ts.
 *
 * What these prove is the shape of what we send: that the role switch happens,
 * that values are bound rather than interpolated, and that malformed input is
 * refused loudly instead of failing closed and silently.
 */

interface Call {
  sql: string;
  params?: unknown[];
}

function recordingClient(): { client: PoolClient; calls: Call[] } {
  const calls: Call[] = [];
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, ...(params ? { params } : {}) });
      return { rows: [] };
    },
  } as unknown as PoolClient;
  return { client, calls };
}

const employee: RlsSession = {
  userId: '11111111-2222-3333-4444-555555555555',
  role: 'EMPLOYEE',
};

describe('applyRlsContext', () => {
  it('switches to app_role FIRST, before any value is set', async () => {
    // Order matters. app_role owns nothing, so the role switch is what makes the
    // policies apply even if the connection user is the table owner (D-21).
    const { client, calls } = recordingClient();
    await applyRlsContext(client, employee);
    expect(calls[0]?.sql).toBe(`SET LOCAL ROLE ${APP_ROLE}`);
  });

  it('binds user id and role as parameters, never as SQL literals', async () => {
    // SET LOCAL takes no bind parameters, so the literal form would mean
    // interpolating a value into SQL on the authentication path. set_config is
    // the parameterised equivalent.
    const { client, calls } = recordingClient();
    await applyRlsContext(client, employee);

    const setUser = calls.find((c) => c.sql.includes("'app.user_id'"));
    const setRole = calls.find((c) => c.sql.includes("'app.user_role'"));

    expect(setUser?.params).toEqual([employee.userId]);
    expect(setRole?.params).toEqual(['EMPLOYEE']);
    // The value must not appear in the SQL text itself.
    expect(setUser?.sql).not.toContain(employee.userId);
    expect(setRole?.sql).not.toContain('EMPLOYEE');
  });

  it('scopes both settings to the transaction', async () => {
    // The third argument to set_config is is_local. Without it the setting would
    // outlive the transaction and leak into the next request on that pooled
    // connection — a rep would inherit whoever used the connection before.
    const { client, calls } = recordingClient();
    await applyRlsContext(client, employee);
    for (const c of calls.filter((x) => x.sql.includes('set_config'))) {
      expect(c.sql).toContain('true)');
    }
  });

  it('refuses a malformed user id rather than failing closed silently', async () => {
    // A bad value would make current_employee_id() return NULL, and a NULL
    // comparison in a policy is false. That fails closed, which is safe — but
    // silently, which means a broken session looks like an empty account.
    const { client } = recordingClient();
    await expect(
      applyRlsContext(client, { userId: "'; DROP TABLE lead; --", role: 'EMPLOYEE' }),
    ).rejects.toThrow(/not a UUID/);
    await expect(applyRlsContext(client, { userId: '', role: 'EMPLOYEE' })).rejects.toThrow(
      /not a UUID/,
    );
  });

  it('refuses an unknown role', async () => {
    const { client } = recordingClient();
    await expect(
      applyRlsContext(client, { userId: employee.userId, role: 'SUPERUSER' as never }),
    ).rejects.toThrow(/unknown role/);
  });

  it('sends nothing at all when validation fails', async () => {
    // Refusal must happen before the role switch, or a rejected session would
    // still have mutated the connection.
    const { client, calls } = recordingClient();
    await expect(applyRlsContext(client, { userId: 'nope', role: 'EMPLOYEE' })).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('accepts all three roles', async () => {
    for (const role of ['OWNER', 'ADMIN', 'EMPLOYEE'] as const) {
      const { client } = recordingClient();
      await expect(applyRlsContext(client, { ...employee, role })).resolves.toBeUndefined();
    }
  });
});
