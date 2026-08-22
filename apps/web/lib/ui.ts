import type { CSSProperties } from 'react';

/**
 * Design tokens from design/design-tokens.md.
 *
 * "Radius 3px throughout. This is an operations tool, not a consumer app."
 * Numbers are always monospace with tabular figures, because columns must align
 * in an MIS tool — that one is called non-negotiable in the tokens file.
 */
export const T = {
  ink: '#14161F',
  ink2: '#1D2130',
  paper: '#E7EAEE',
  card: '#FFFFFF',
  line: '#D4D9E0',
  line2: '#E8EBEF',
  text: '#181B24',
  muted: '#606A7B',
  faint: '#8C95A4',
  brass: '#C08A1E',
  vine: '#1C6B49',
  clay: '#B03A2C',
  indigo: '#2E4A8F',
} as const;

const DISPLAY = '600 12px/1.1 "Barlow Condensed", system-ui, sans-serif';
const MONO = '"IBM Plex Mono", ui-monospace, SFMono-Regular, monospace';

export const s = {
  page: { padding: '20px 24px', color: T.text, maxWidth: 1180, margin: '0 auto' },
  h1: {
    font: '600 22px/1.2 "Barlow Condensed", system-ui, sans-serif',
    letterSpacing: '1.6px',
    textTransform: 'uppercase',
    margin: '0 0 4px',
  },
  sub: { color: T.muted, fontSize: 13, margin: '0 0 20px' },

  card: {
    background: T.card,
    border: `1px solid ${T.line}`,
    borderRadius: 3,
    padding: 14,
    marginBottom: 14,
  },
  cardHead: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    font: DISPLAY,
    letterSpacing: '1.4px',
    textTransform: 'uppercase',
    color: T.muted,
    paddingBottom: 10,
    borderBottom: `1px solid ${T.line2}`,
    marginBottom: 10,
  },

  table: { width: '100%', borderCollapse: 'collapse', fontSize: 12.8 },
  th: {
    textAlign: 'left',
    padding: '8px 6px',
    borderBottom: `1px solid ${T.line}`,
    font: DISPLAY,
    letterSpacing: '1.2px',
    textTransform: 'uppercase',
    color: T.muted,
    whiteSpace: 'nowrap',
  },
  td: { padding: '8px 6px', borderBottom: `1px solid ${T.line2}`, verticalAlign: 'top' },
  /** Every number, id, code and currency value. Non-negotiable per the tokens. */
  mono: { fontFamily: MONO, fontVariantNumeric: 'tabular-nums', fontSize: 12.4 },

  btn: {
    border: `1px solid ${T.line}`,
    background: T.card,
    color: T.text,
    borderRadius: 3,
    padding: '6px 11px',
    fontSize: 13,
    cursor: 'pointer',
  },
  btnPrimary: {
    border: `1px solid ${T.ink}`,
    background: T.ink,
    color: '#fff',
    borderRadius: 3,
    padding: '7px 15px',
    fontSize: 13,
    cursor: 'pointer',
  },
  btnDisabled: {
    border: `1px solid ${T.line}`,
    background: T.paper,
    color: T.faint,
    borderRadius: 3,
    padding: '7px 15px',
    fontSize: 13,
    cursor: 'not-allowed',
  },
  input: {
    border: `1px solid ${T.line}`,
    borderRadius: 3,
    padding: '7px 9px',
    fontSize: 13,
    width: '100%',
    background: T.card,
    color: T.text,
  },
  label: { display: 'block', fontSize: 12, color: T.muted, marginBottom: 4 },

  /** Status is never colour alone — always paired with a word (docs/07 §6). */
  pill: (tone: 'ok' | 'warn' | 'bad' | 'flat'): CSSProperties => ({
    display: 'inline-block',
    font: MONO,
    fontSize: 11,
    padding: '2px 7px',
    borderRadius: 3,
    border: `1px solid ${{ ok: T.vine, warn: T.brass, bad: T.clay, flat: T.line }[tone]}`,
    color: { ok: T.vine, warn: T.brass, bad: T.clay, flat: T.muted }[tone],
    background: T.card,
    whiteSpace: 'nowrap',
  }),

  /**
   * `flat` is the neutral tone: a caveat that is information rather than a
   * problem — "working days this month", "ROI is omitted because no spend is
   * recorded". Colouring those amber would train people to ignore amber.
   */
  notice: (tone: 'ok' | 'warn' | 'bad' | 'flat'): CSSProperties => ({
    border: `1px solid ${{ ok: T.vine, warn: T.brass, bad: T.clay, flat: T.line }[tone]}`,
    background: T.card,
    borderRadius: 3,
    padding: 12,
    marginBottom: 14,
    fontSize: 13,
    whiteSpace: 'pre-wrap',
  }),

  empty: { color: T.muted, fontSize: 13, padding: '18px 6px' },

  /** The sentence under a page title that says what the screen is for. */
  lede: { color: T.muted, fontSize: 13.5, maxWidth: 680, margin: '0 0 16px' },

  /** Small print that qualifies what is above it — caveats, footnotes, warnings. */
  hint: { color: T.muted, fontSize: 12, margin: '6px 0 0' },
  srOnly: {
    position: 'absolute',
    width: 1,
    height: 1,
    overflow: 'hidden',
    clip: 'rect(0 0 0 0)',
  },
} satisfies Record<string, CSSProperties | ((...args: never[]) => CSSProperties)>;

export const statusTone = (status: string): 'ok' | 'warn' | 'bad' | 'flat' => {
  switch (status) {
    case 'COMMITTED':
    case 'VALID':
      return 'ok';
    case 'WARNING':
    case 'REVIEW':
    case 'MAPPING':
      return 'warn';
    case 'SHIFTED':
    case 'ERROR':
    case 'FAILED':
    case 'PARKED':
      return 'bad';
    default:
      return 'flat';
  }
};
