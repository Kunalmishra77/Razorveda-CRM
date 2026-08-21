/**
 * @razorveda/shared — Zod schemas, types, enums and constants.
 *
 * Imported by apps/api AND apps/web. One definition, both sides (CLAUDE.md section 3).
 * Nothing in here performs I/O, and nothing here computes a money figure.
 */

export * from './enums.js';
export * from './primitives.js';
export * from './money.js';
export * from './selection.js';
export * from './normalise/index.js';
export * from './normalise/type-contracts.js';
export * from './normalise/column-shift.js';
export * from './ingestion/fingerprint.js';
export * from './ingestion/column-mapping.js';
export * from './ingestion/validate-row.js';
export * from './crypto-params.js';
export * from './forecast-params.js';

export * from './entities/auth.js';
export * from './entities/masters.js';
export * from './entities/identity.js';
export * from './entities/leads.js';
export * from './entities/orders.js';
export * from './entities/money.js';
export * from './entities/ingestion.js';
export * from './entities/governance.js';
