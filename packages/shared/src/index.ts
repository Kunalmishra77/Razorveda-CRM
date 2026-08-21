/**
 * @razorveda/shared — Zod schemas, types, enums and constants.
 *
 * Imported by apps/api AND apps/web. One definition, both sides (CLAUDE.md §3).
 * Nothing in here performs I/O, and nothing here computes a money figure.
 *
 * THIS BARREL MUST STAY BROWSER-SAFE. Anything importing `node:*` belongs in
 * `./server.js` instead. `fingerprint.ts` needs `node:crypto`, and re-exporting
 * it here dragged that into the web bundle — webpack failed with
 * "Reading from node:crypto is not handled by plugins". A package imported by
 * both sides has to be honest about which half is which.
 */

export * from './enums.js';
export * from './primitives.js';
export * from './money.js';
export * from './selection.js';
export * from './normalise/index.js';
export * from './normalise/type-contracts.js';
export * from './normalise/column-shift.js';
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
