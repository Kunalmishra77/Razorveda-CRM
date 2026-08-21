import { describe, it, expect } from 'vitest';
import {
  BAND_LABEL, BAND_ORDER, BAND_TOKEN, bandCounts, bandLeads, bandOf,
  type WorklistLead,
} from '../src/worklist/order-worklist.js';

const NOW = '2026-08-21T11:00:00.000Z';

const mk = (over: Partial<WorklistLead> = {}): WorklistLead => ({
  leadId: 'l1',
  nextFollowupAt: null,
  repeatDueDate: null,
  assignedAt: '2026-08-01T09:00:00.000Z',
  validTill: null,
  isConverted: false,
  closedAt: null,
  ...over,
});

describe('the fixed order matches docs/07 §4', () => {
  it('is overdue, due today, repeat, fresh, ageing', () => {
    expect(BAND_ORDER).toEqual([
      'OVERDUE_FOLLOWUP', 'DUE_TODAY', 'REPEAT_DUE', 'FRESH', 'AGEING',
    ]);
  });

  it('pairs every colour with a text label', () => {
    // docs/07 §6: no colour-only status encoding, ever.
    for (const band of BAND_ORDER) {
      expect(BAND_LABEL[band], `${band} has no label`).toBeTruthy();
      expect(BAND_TOKEN[band], `${band} has no colour token`).toBeTruthy();
    }
  });
});

describe('banding', () => {
  it('puts a follow-up promised yesterday in Overdue', () => {
    expect(bandOf(mk({ nextFollowupAt: '2026-08-20T15:00:00.000Z' }), NOW)).toBe(
      'OVERDUE_FOLLOWUP',
    );
  });

  it('puts a follow-up promised for today in Due today, even if the hour has passed', () => {
    // A 09:00 promise at 11:00 is still today's work, not a failure. Bumping it to
    // Overdue mid-morning would make the top of the list churn all day.
    expect(bandOf(mk({ nextFollowupAt: '2026-08-21T09:00:00.000Z' }), NOW)).toBe('DUE_TODAY');
    expect(bandOf(mk({ nextFollowupAt: '2026-08-21T18:00:00.000Z' }), NOW)).toBe('DUE_TODAY');
  });

  it('puts a repeat-due customer in Repeat due', () => {
    expect(bandOf(mk({ repeatDueDate: '2026-08-21' }), NOW)).toBe('REPEAT_DUE');
    expect(bandOf(mk({ repeatDueDate: '2026-08-19' }), NOW)).toBe('REPEAT_DUE');
  });

  it('does not surface a repeat that is not due yet', () => {
    expect(bandOf(mk({ repeatDueDate: '2026-08-25' }), NOW)).toBe('AGEING');
  });

  it('puts a lead assigned today in Fresh', () => {
    expect(bandOf(mk({ assignedAt: '2026-08-21T08:00:00.000Z' }), NOW)).toBe('FRESH');
  });

  it('drops everything else into Ageing', () => {
    expect(bandOf(mk(), NOW)).toBe('AGEING');
  });
});

describe('the most urgent truth wins when a lead is several things at once', () => {
  it('ranks an overdue follow-up above a repeat that is also due', () => {
    // A promise the rep made beats a system-generated nudge. Ranking by the most
    // recently written field instead would bury the promise.
    const both = mk({ nextFollowupAt: '2026-08-19T10:00:00.000Z', repeatDueDate: '2026-08-19' });
    expect(bandOf(both, NOW)).toBe('OVERDUE_FOLLOWUP');
  });

  it('ranks today follow-up above repeat due', () => {
    const both = mk({ nextFollowupAt: '2026-08-21T16:00:00.000Z', repeatDueDate: '2026-08-01' });
    expect(bandOf(both, NOW)).toBe('DUE_TODAY');
  });

  it('ranks repeat due above a lead that merely arrived today', () => {
    const both = mk({ repeatDueDate: '2026-08-20', assignedAt: '2026-08-21T08:00:00.000Z' });
    expect(bandOf(both, NOW)).toBe('REPEAT_DUE');
  });
});

describe('closed and converted leads leave the worklist', () => {
  it('drops a converted lead', () => {
    expect(bandOf(mk({ isConverted: true, nextFollowupAt: '2026-08-01T10:00:00Z' }), NOW)).toBeNull();
  });

  it('drops a closed lead even with an overdue follow-up', () => {
    // 174 client leads sat with a rep for a full validity window producing
    // nothing. A dead lead must not keep claiming the top of the list.
    expect(bandOf(mk({ closedAt: '2026-08-10T10:00:00Z', nextFollowupAt: '2026-08-01T10:00:00Z' }), NOW))
      .toBeNull();
  });

  it('excludes them from the ordered list entirely', () => {
    const ordered = bandLeads(
      [mk({ leadId: 'live' }), mk({ leadId: 'dead', closedAt: '2026-08-10T10:00:00Z' })],
      NOW,
    );
    expect(ordered.map((b) => b.lead.leadId)).toEqual(['live']);
  });
});

describe('ordering within and across bands', () => {
  it('sorts strictly by band first', () => {
    const ordered = bandLeads(
      [
        mk({ leadId: 'ageing' }),
        mk({ leadId: 'fresh', assignedAt: '2026-08-21T08:00:00.000Z' }),
        mk({ leadId: 'overdue', nextFollowupAt: '2026-08-18T10:00:00.000Z' }),
        mk({ leadId: 'repeat', repeatDueDate: '2026-08-20' }),
        mk({ leadId: 'today', nextFollowupAt: '2026-08-21T15:00:00.000Z' }),
      ],
      NOW,
    );
    expect(ordered.map((b) => b.lead.leadId)).toEqual([
      'overdue', 'today', 'repeat', 'fresh', 'ageing',
    ]);
  });

  it('puts the longest-overdue follow-up first', () => {
    const ordered = bandLeads(
      [
        mk({ leadId: 'recent', nextFollowupAt: '2026-08-20T10:00:00.000Z' }),
        mk({ leadId: 'ancient', nextFollowupAt: '2026-08-05T10:00:00.000Z' }),
      ],
      NOW,
    );
    expect(ordered.map((b) => b.lead.leadId)).toEqual(['ancient', 'recent']);
  });

  it('works fresh leads first-in first-out', () => {
    const ordered = bandLeads(
      [
        mk({ leadId: 'later', assignedAt: '2026-08-21T10:00:00.000Z' }),
        mk({ leadId: 'earlier', assignedAt: '2026-08-21T08:00:00.000Z' }),
      ],
      NOW,
    );
    expect(ordered.map((b) => b.lead.leadId)).toEqual(['earlier', 'later']);
  });

  it('surfaces the ageing lead closest to expiry first', () => {
    // Leads decay against Data Valid Till. A last chance beats strict age order.
    const ordered = bandLeads(
      [
        mk({ leadId: 'plenty', validTill: '2026-09-30' }),
        mk({ leadId: 'expiring', validTill: '2026-08-22' }),
        mk({ leadId: 'no-expiry', validTill: null }),
      ],
      NOW,
    );
    expect(ordered.map((b) => b.lead.leadId)).toEqual(['expiring', 'plenty', 'no-expiry']);
  });

  it('is stable — the same worklist does not reshuffle between refreshes', () => {
    // A list that reorders under the rep mid-call is its own kind of data loss.
    const leads = [
      mk({ leadId: 'b', nextFollowupAt: '2026-08-20T10:00:00.000Z' }),
      mk({ leadId: 'a', nextFollowupAt: '2026-08-20T10:00:00.000Z' }),
      mk({ leadId: 'c', nextFollowupAt: '2026-08-20T10:00:00.000Z' }),
    ];
    const once = bandLeads(leads, NOW).map((b) => b.lead.leadId);
    const twice = bandLeads([...leads].reverse(), NOW).map((b) => b.lead.leadId);
    expect(once).toEqual(['a', 'b', 'c']);
    expect(twice).toEqual(once);
  });
});

describe('bandCounts for the My Day header', () => {
  it('counts every band, including empty ones', () => {
    const counts = bandCounts(
      bandLeads(
        [
          mk({ leadId: '1', nextFollowupAt: '2026-08-18T10:00:00.000Z' }),
          mk({ leadId: '2', nextFollowupAt: '2026-08-19T10:00:00.000Z' }),
          mk({ leadId: '3', repeatDueDate: '2026-08-20' }),
        ],
        NOW,
      ),
    );
    expect(counts).toEqual({
      OVERDUE_FOLLOWUP: 2, DUE_TODAY: 0, REPEAT_DUE: 1, FRESH: 0, AGEING: 0,
    });
  });

  it('returns all-zero for an empty worklist', () => {
    // An empty state is an invitation, not a blank (docs/07 §5) — the UI needs
    // the zeroes present to render it.
    expect(bandCounts([])).toEqual({
      OVERDUE_FOLLOWUP: 0, DUE_TODAY: 0, REPEAT_DUE: 0, FRESH: 0, AGEING: 0,
    });
  });
});
