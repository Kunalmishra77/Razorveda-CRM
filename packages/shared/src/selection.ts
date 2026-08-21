/**
 * Table selection model for the bulk assignment console (docs/07 §3).
 *
 * Pulled out of the React component on purpose. Phase 1 exit criterion 3 is
 * "shift-click range selection works — manual check, documented", and a manual
 * check is a thing that gets done once and then assumed forever. Modelled as pure
 * functions it becomes a test, and the default answer applies: if something is
 * untestable as specified, make it testable and say what changed.
 *
 * "Reps think in spreadsheet terms — this must feel familiar" (docs/07 §3), so the
 * behaviour deliberately copies a spreadsheet rather than inventing something.
 */

export interface SelectionState {
  /** Explicitly ticked ids. Meaningless while `allInFilter` is true. */
  readonly ids: ReadonlySet<string>;
  /**
   * "Select all in filter" selects ACROSS PAGINATION, not just the visible page
   * (docs/07 §3). The set then holds EXCLUSIONS — ids the admin unticked after
   * selecting everything — because the full id list may be 486 rows the client
   * never fetched.
   */
  readonly allInFilter: boolean;
  /** Anchor for the next shift-click, as in a spreadsheet. */
  readonly anchorId: string | null;
}

export const emptySelection = (): SelectionState => ({
  ids: new Set(),
  allInFilter: false,
  anchorId: null,
});

export const isSelected = (state: SelectionState, id: string): boolean =>
  state.allInFilter ? !state.ids.has(id) : state.ids.has(id);

/**
 * How many rows are selected. Needs the filter total because "all in filter" can
 * cover rows that were never loaded.
 */
export const selectedCount = (state: SelectionState, totalInFilter: number): number =>
  state.allInFilter ? Math.max(totalInFilter - state.ids.size, 0) : state.ids.size;

const withToggled = (set: ReadonlySet<string>, id: string): Set<string> => {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
};

/** Plain click on a checkbox. Also moves the shift-click anchor, as a spreadsheet does. */
export function toggle(state: SelectionState, id: string): SelectionState {
  return { ...state, ids: withToggled(state.ids, id), anchorId: id };
}

/**
 * Shift-click: select the range from the anchor to `id` inclusive, in the order
 * currently displayed.
 *
 * With no anchor it behaves as a plain click — which is what a spreadsheet does,
 * and it avoids selecting everything above the row when the admin shift-clicks
 * first by accident.
 *
 * The range takes the value of the ANCHOR, so shift-clicking from an unticked
 * anchor deselects the range. That is the behaviour people expect but rarely
 * think to ask for, and its absence feels broken.
 */
export function shiftClick(
  state: SelectionState,
  id: string,
  visibleIds: readonly string[],
): SelectionState {
  if (state.anchorId === null) return toggle(state, id);

  const from = visibleIds.indexOf(state.anchorId);
  const to = visibleIds.indexOf(id);
  // Anchor scrolled out of the current page, or an unknown id: fall back to a
  // plain click rather than silently selecting nothing.
  if (from === -1 || to === -1) return toggle(state, id);

  const [lo, hi] = from <= to ? [from, to] : [to, from];
  const range = visibleIds.slice(lo, hi + 1);
  const selecting = isSelected(state, state.anchorId);

  const ids = new Set(state.ids);
  for (const rangeId of range) {
    if (state.allInFilter) {
      // Inverted: the set holds exclusions.
      if (selecting) ids.delete(rangeId);
      else ids.add(rangeId);
    } else if (selecting) ids.add(rangeId);
    else ids.delete(rangeId);
  }

  // Anchor does NOT move on shift-click, so repeated shift-clicks grow and shrink
  // the same range from a fixed point — again, spreadsheet behaviour.
  return { ...state, ids };
}

/** Header checkbox: every row on the CURRENT page. */
export function toggleVisible(
  state: SelectionState,
  visibleIds: readonly string[],
): SelectionState {
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => isSelected(state, id));

  const ids = new Set(state.ids);
  for (const id of visibleIds) {
    if (state.allInFilter) {
      if (allVisibleSelected) ids.add(id);
      else ids.delete(id);
    } else if (allVisibleSelected) ids.delete(id);
    else ids.add(id);
  }
  return { ...state, ids, anchorId: null };
}

/** "Select all in filter" — across pagination, not just the visible page. */
export const selectAllInFilter = (): SelectionState => ({
  ids: new Set(),
  allInFilter: true,
  anchorId: null,
});

export const clearSelection = (): SelectionState => emptySelection();

/** "Select first 25" — the quick action in docs/07 §3. */
export function selectFirstN(visibleIds: readonly string[], n: number): SelectionState {
  return { ids: new Set(visibleIds.slice(0, n)), allInFilter: false, anchorId: null };
}

/**
 * What the client sends to the API.
 *
 * With `allInFilter` the client sends the FILTER plus exclusions, never a list of
 * 486 ids it may not hold. The server re-runs the filter inside the assigning
 * transaction, so the set assigned is the set that exists at commit time rather
 * than a snapshot the admin loaded ten minutes ago.
 */
export type AssignRequest =
  | { readonly mode: 'IDS'; readonly leadIds: readonly string[] }
  | { readonly mode: 'FILTER'; readonly excludeLeadIds: readonly string[] };

export function toAssignRequest(state: SelectionState): AssignRequest {
  return state.allInFilter
    ? { mode: 'FILTER', excludeLeadIds: [...state.ids] }
    : { mode: 'IDS', leadIds: [...state.ids] };
}
