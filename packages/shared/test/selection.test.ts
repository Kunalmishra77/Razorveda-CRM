import { describe, it, expect } from 'vitest';
import {
  clearSelection, emptySelection, isSelected, selectAllInFilter, selectFirstN,
  selectedCount, shiftClick, toAssignRequest, toggle, toggleVisible,
} from '../src/selection.js';

/**
 * Phase 1 exit criterion 3: "shift-click range selection works".
 *
 * The phase doc's proof is "manual check, documented". A manual check is done once
 * and assumed forever, so the behaviour lives here as pure functions instead and
 * the criterion becomes a test. Behaviour copies a spreadsheet deliberately —
 * docs/07 §3: "reps think in spreadsheet terms — this must feel familiar".
 */

const PAGE = ['a', 'b', 'c', 'd', 'e'];
const sel = (s: ReturnType<typeof emptySelection>, ids: readonly string[]) =>
  ids.filter((id) => isSelected(s, id));

describe('plain clicking', () => {
  it('ticks and unticks', () => {
    let s = toggle(emptySelection(), 'b');
    expect(sel(s, PAGE)).toEqual(['b']);
    s = toggle(s, 'b');
    expect(sel(s, PAGE)).toEqual([]);
  });

  it('moves the anchor', () => {
    expect(toggle(emptySelection(), 'c').anchorId).toBe('c');
  });
});

describe('shift-click range selection', () => {
  it('selects the range from the anchor downward', () => {
    let s = toggle(emptySelection(), 'b');
    s = shiftClick(s, 'd', PAGE);
    expect(sel(s, PAGE)).toEqual(['b', 'c', 'd']);
  });

  it('selects upward too', () => {
    let s = toggle(emptySelection(), 'd');
    s = shiftClick(s, 'b', PAGE);
    expect(sel(s, PAGE)).toEqual(['b', 'c', 'd']);
  });

  it('keeps the anchor fixed so the range can be grown and shrunk', () => {
    // Spreadsheet behaviour: repeated shift-clicks resize the same range.
    let s = toggle(emptySelection(), 'b');
    s = shiftClick(s, 'e', PAGE);
    expect(sel(s, PAGE)).toEqual(['b', 'c', 'd', 'e']);
    s = shiftClick(s, 'c', PAGE);
    expect(s.anchorId).toBe('b');
    expect(sel(s, PAGE)).toContain('b');
    expect(sel(s, PAGE)).toContain('c');
  });

  it('DESELECTS a range when the anchor is unticked', () => {
    // The behaviour people expect but never think to ask for, and whose absence
    // feels broken: shift-clicking from an unticked row clears the range.
    let s = selectFirstN(PAGE, 5);
    s = toggle(s, 'b'); // untick b, anchor now b
    s = shiftClick(s, 'd', PAGE);
    expect(sel(s, PAGE)).toEqual(['a', 'e']);
  });

  it('behaves as a plain click with no anchor', () => {
    // Avoids selecting everything above the row when an admin shift-clicks first
    // by accident.
    const s = shiftClick(emptySelection(), 'c', PAGE);
    expect(sel(s, PAGE)).toEqual(['c']);
  });

  it('falls back to a plain click when the anchor scrolled off the page', () => {
    const s = shiftClick({ ...toggle(emptySelection(), 'z'), anchorId: 'z' }, 'c', PAGE);
    expect(sel(s, PAGE)).toEqual(['c']);
  });

  it('selects a single row when anchor and target are the same', () => {
    let s = toggle(emptySelection(), 'c');
    s = shiftClick(s, 'c', PAGE);
    expect(sel(s, PAGE)).toEqual(['c']);
  });
});

describe('header select-all covers the visible page only', () => {
  it('selects then clears the page', () => {
    let s = toggleVisible(emptySelection(), PAGE);
    expect(sel(s, PAGE)).toEqual(PAGE);
    s = toggleVisible(s, PAGE);
    expect(sel(s, PAGE)).toEqual([]);
  });

  it('does not touch rows on other pages', () => {
    const s = toggleVisible(emptySelection(), ['a', 'b']);
    expect(isSelected(s, 'c')).toBe(false);
  });

  it('completes a partial page rather than clearing it', () => {
    let s = toggle(emptySelection(), 'b');
    s = toggleVisible(s, PAGE);
    expect(sel(s, PAGE)).toEqual(PAGE);
  });
});

describe('select all in filter — across pagination', () => {
  it('selects rows that were never loaded', () => {
    // docs/07 §3: selects across pagination, not just the visible page. The pool
    // is 486 rows; the client holds 25.
    const s = selectAllInFilter();
    expect(isSelected(s, 'never-fetched-row')).toBe(true);
    expect(selectedCount(s, 486)).toBe(486);
  });

  it('treats an untick as an exclusion', () => {
    const s = toggle(selectAllInFilter(), 'c');
    expect(isSelected(s, 'c')).toBe(false);
    expect(isSelected(s, 'a')).toBe(true);
    expect(selectedCount(s, 486)).toBe(485);
  });

  it('shift-click deselects a range while in all-in-filter mode', () => {
    let s = toggle(selectAllInFilter(), 'b'); // exclude b, anchor b
    s = shiftClick(s, 'd', PAGE);
    expect(sel(s, PAGE)).toEqual(['a', 'e']);
    expect(selectedCount(s, 486)).toBe(483);
  });

  it('never reports a negative count', () => {
    let s = selectAllInFilter();
    for (const id of PAGE) s = toggle(s, id);
    expect(selectedCount(s, 3)).toBe(0);
  });
});

describe('what gets sent to the API', () => {
  it('sends explicit ids in normal mode', () => {
    const s = selectFirstN(PAGE, 3);
    expect(toAssignRequest(s)).toEqual({ mode: 'IDS', leadIds: ['a', 'b', 'c'] });
  });

  it('sends the filter plus exclusions in all-in-filter mode', () => {
    // The client must never post 486 ids it does not hold. The server re-runs the
    // filter inside the assigning transaction, so the set assigned is the set that
    // exists at commit time, not a snapshot the admin loaded ten minutes ago.
    const s = toggle(selectAllInFilter(), 'c');
    expect(toAssignRequest(s)).toEqual({ mode: 'FILTER', excludeLeadIds: ['c'] });
  });
});

describe('quick actions', () => {
  it('selects the first N', () => {
    expect(sel(selectFirstN(PAGE, 3), PAGE)).toEqual(['a', 'b', 'c']);
  });

  it('clears everything, including all-in-filter mode', () => {
    const s = clearSelection();
    expect(s.allInFilter).toBe(false);
    expect(selectedCount(s, 486)).toBe(0);
  });
});
