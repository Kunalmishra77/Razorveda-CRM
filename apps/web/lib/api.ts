/**
 * The single door to the API.
 *
 * `credentials: 'include'` on every call, because the access token lives in an
 * HttpOnly cookie and is deliberately unreadable from script (D-110). Nothing in
 * the web app ever holds a token, so nothing in the web app can leak one.
 */

const API = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      ...init,
      credentials: 'include',
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    // A network failure is not a server error, and saying so saves someone
    // reading logs for a problem that is a stopped process (docs/07 §5).
    throw new ApiError(
      `Cannot reach the API at ${API}. Check that it is running — npm run dev.`,
      0,
    );
  }

  if (response.status === 401) {
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    throw new ApiError(body.message ?? 'Your session has ended. Sign in again.', 401);
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    throw new ApiError(body.message ?? `That request failed (HTTP ${response.status}).`, response.status);
  }

  return (await response.json()) as T;
}

export const api = {
  get: <T>(path: string): Promise<T> => request<T>(path),
  post: <T>(path: string, body?: unknown): Promise<T> =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) }),
};

// ─── shapes the screens use ─────────────────────────────────────────────────

export interface Session {
  userId: string;
  role: 'OWNER' | 'ADMIN' | 'EMPLOYEE';
}

export interface LoginResponse {
  ok: boolean;
  reason?: string;
  message?: string;
  user?: { userId: string; role: Session['role']; fullName: string };
}

export interface UploadResponse {
  ok: boolean;
  status?: 'SHIFTED' | 'DUPLICATE';
  message?: string;
  batchId?: string;
  rows?: number;
  clean?: number;
  exceptions?: number;
  offenders?: Array<{ column: string; expectedType: string; failureRate: number; sample: string[] }>;
}

export interface Batch {
  batch_id: string;
  file_name: string;
  status: string;
  row_count: number;
  rows_committed: number;
  created_at: string;
  source: string;
  exceptions: string;
}

export interface ExceptionRow {
  staging_id: string;
  row_number: number;
  validation_status: string;
  validation_errors: Array<{ field: string; code: string; message: string; severity: string }>;
  raw_json: Record<string, string>;
  normalised_json: Record<string, string | null>;
}

export interface PoolLead {
  lead_id: string;
  full_name: string | null;
  primary_phone: string | null;
  state: string | null;
  source: string;
  product_interest: string | null;
  age_hours: number;
  past_validity: boolean;
}

export interface Rep {
  employee_id: string;
  full_name: string;
  status: string;
  wip_cap: number;
  open_leads: string;
  yield_per_lead: string;
}

export interface Warning {
  code: string;
  message: string;
  count: number;
}
