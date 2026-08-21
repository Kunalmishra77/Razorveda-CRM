import { z } from 'zod';
import { pgEnum } from '../primitives.js';
import { UserRole } from '../enums.js';

/**
 * Auth contracts shared by apps/api and apps/web, so the form and the endpoint
 * cannot disagree about what a valid login looks like.
 *
 * The real implementation is Phase 1 week 3: Argon2id, JWT 15 min + rotating
 * refresh, TOTP for ADMIN and OWNER, single active session, shift-hours window,
 * 10 minute idle logout (docs/05).
 */
export const loginSchema = z.object({
  email: z.string().email('enter a valid email address'),
  password: z.string().min(1, 'enter your password'),
  /** Required for ADMIN and OWNER. Six digits, checked server-side. */
  totp: z.string().regex(/^\d{6}$/, 'enter the 6-digit code').optional(),
});

/**
 * A locked account cannot authenticate until an admin unlocks it (docs/05 test 8).
 * Two things use this today: the copy-velocity lock, and the OWNER account, which
 * is seeded locked until O-07 nominates a person (D-41).
 */
export const loginFailureSchema = z.object({
  reason: z.enum(['INVALID_CREDENTIALS', 'ACCOUNT_LOCKED', 'OUTSIDE_SHIFT_HOURS', 'TOTP_REQUIRED']),
  /** Shown to the user. Says what happened and what to do next (docs/07 section 5). */
  message: z.string(),
});

export const sessionSchema = z.object({
  userId: z.string().uuid(),
  role: pgEnum(UserRole),
  employeeId: z.string().uuid().nullable(),
  fullName: z.string(),
  expiresAt: z.string().datetime(),
});

export type Login = z.infer<typeof loginSchema>;
export type LoginFailure = z.infer<typeof loginFailureSchema>;
export type Session = z.infer<typeof sessionSchema>;
