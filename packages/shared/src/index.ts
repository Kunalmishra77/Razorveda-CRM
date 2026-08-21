/**
 * @razorveda/shared — Zod schemas, types, enums and constants.
 *
 * Imported by apps/api AND apps/web. One definition, both sides (CLAUDE.md section 3).
 * Nothing in here performs I/O, and nothing here computes a money figure.
 */

export * from './enums.js';
export * from './primitives.js';
export * from './money.js';
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
