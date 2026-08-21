import {
  FREE_TEXT_STRUCTURED_THRESHOLD,
  satisfiesContract,
  structuredLookAlikeRatio,
  type TypeContract,
} from './type-contracts.js';

/**
 * The column-shift detector (docs/06 section 5, D-12, finding F3).
 *
 * The client's `Order Status` column holds 40+ customer names, `Client Category`
 * holds PIN codes, and `Data Resource` holds AWB numbers — all because a
 * copy-paste landed one column out. Nobody noticed for months, because every
 * individual row looked plausible.
 *
 * The rule: if more than 20% of the non-empty values in any mapped column fail
 * that column's type check, the WHOLE BATCH is rejected before staging. Not the
 * row — the batch. A shift is a property of the file, and importing the 80% that
 * happened to pass would scatter corruption through the customer master where it
 * is far more expensive to find.
 */

export const SHIFT_FAILURE_THRESHOLD = 0.2;

export interface ColumnCheck {
  /** The source header, so the admin sees the name they recognise from the file. */
  readonly column: string;
  readonly targetField: string;
  readonly contract: TypeContract;
  readonly values: readonly unknown[];
}

export interface ColumnVerdict {
  readonly column: string;
  readonly targetField: string;
  readonly expectedType: string;
  readonly checked: number;
  readonly failed: number;
  readonly failureRate: number;
  /** A few offending values, for the message the admin actually reads. */
  readonly sample: readonly string[];
  readonly reason: 'TYPE_MISMATCH' | 'FREE_TEXT_LOOKS_STRUCTURED';
}

export interface ShiftDetection {
  readonly shifted: boolean;
  readonly offenders: readonly ColumnVerdict[];
  /** Every column's failure rate, so a near-miss is visible before it becomes a miss. */
  readonly allColumns: readonly Omit<ColumnVerdict, 'reason'>[];
}

const asText = (v: unknown): string => String(v ?? '').trim();

export function detectColumnShift(
  columns: readonly ColumnCheck[],
  todayIso: string,
): ShiftDetection {
  const offenders: ColumnVerdict[] = [];
  const allColumns: Array<Omit<ColumnVerdict, 'reason'>> = [];

  for (const col of columns) {
    const nonEmpty = col.values.filter((v) => asText(v) !== '');

    if (col.contract.kind === 'FREE_TEXT') {
      // Cannot fail a type check by definition, so ask a different question:
      // does this column suddenly look like structured data? (B10)
      const ratio = structuredLookAlikeRatio(col.values);
      const structured = nonEmpty.filter((v) => structuredLookAlikeRatio([v]) === 1);
      const verdict = {
        column: col.column,
        targetField: col.targetField,
        expectedType: 'free text',
        checked: nonEmpty.length,
        failed: structured.length,
        failureRate: ratio,
        sample: structured.slice(0, 3).map(asText),
      };
      allColumns.push(verdict);
      if (nonEmpty.length > 0 && ratio > FREE_TEXT_STRUCTURED_THRESHOLD) {
        offenders.push({ ...verdict, reason: 'FREE_TEXT_LOOKS_STRUCTURED' });
      }
      continue;
    }

    const failures = nonEmpty.filter((v) => !satisfiesContract(v, col.contract, todayIso));
    const failureRate = nonEmpty.length === 0 ? 0 : failures.length / nonEmpty.length;
    const verdict = {
      column: col.column,
      targetField: col.targetField,
      expectedType: col.contract.kind.toLowerCase().replace('_', ' '),
      checked: nonEmpty.length,
      failed: failures.length,
      failureRate,
      sample: failures.slice(0, 3).map(asText),
    };
    allColumns.push(verdict);
    if (nonEmpty.length > 0 && failureRate > SHIFT_FAILURE_THRESHOLD) {
      offenders.push({ ...verdict, reason: 'TYPE_MISMATCH' });
    }
  }

  return { shifted: offenders.length > 0, offenders, allColumns };
}

/**
 * The message the admin sees. Says what happened, in which column, with examples,
 * and what to do next (docs/07 section 5) — never "Something went wrong".
 */
export function describeShift(detection: ShiftDetection): string {
  if (!detection.shifted) return '';

  const lines = detection.offenders.map((o) => {
    const pct = Math.round(o.failureRate * 100);
    const examples = o.sample.map((s) => JSON.stringify(s)).join(', ');
    return o.reason === 'FREE_TEXT_LOOKS_STRUCTURED'
      ? `  "${o.column}" should be free text, but ${pct}% of its values look like ` +
          `numbers, PIN codes or AWBs — for example ${examples}`
      : `  "${o.column}" should be ${o.expectedType}, but ${o.failed} of ${o.checked} ` +
          `values (${pct}%) are not — for example ${examples}`;
  });

  return [
    'This file looks like its columns have shifted, so nothing was imported.',
    '',
    ...lines,
    '',
    'A shift usually comes from a copy-paste that landed one column out. Check the',
    'file against the expected layout, fix it, and upload again. Nothing has changed',
    'in the CRM.',
  ].join('\n');
}
