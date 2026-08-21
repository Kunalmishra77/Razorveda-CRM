import { describe, it, expect } from 'vitest';
import {
  AGEING_THRESHOLD_HOURS, preAssignWarnings, suggestSplit,
  type PoolLead, type RepSnapshot,
} from '../src/assignment/pre-assign-warnings.js';

const rep = (over: Partial<RepSnapshot> = {}): RepSnapshot => ({
  employeeId: 'e-kajal',
  fullName: 'Kajal',
  status: 'ACTIVE',
  wipCap: 100,
  openLeads: 20,
  yieldPerLead: 500,
  ...over,
});

const lead = (over: Partial<PoolLead> = {}): PoolLead => ({
  leadId: 'l1',
  customerId: 'c1',
  ageHours: 1,
  pastValidity: false,
  ownedByEmployeeId: null,
  ...over,
});

const many = (n: number, over: Partial<PoolLead> = {}): PoolLead[] =>
  Array.from({ length: n }, (_, i) => lead({ leadId: `l${i}`, customerId: `c${i}`, ...over }));

describe('warnings advise, never block', () => {
  it('returns nothing when everything is fine', () => {
    expect(preAssignWarnings(rep(), many(10), many(10))).toEqual([]);
  });

  it('warns that a rep is over her cap, with the real numbers', () => {
    // docs/07 §3: "Kajal already has 120 open leads".
    const w = preAssignWarnings(rep({ openLeads: 120, wipCap: 100 }), many(10), many(10));
    const overloaded = w.find((x) => x.code === 'REP_OVERLOADED');
    expect(overloaded?.message).toContain('120 open leads');
    expect(overloaded?.message).toContain('130');
    expect(overloaded?.message).toContain('cap of 100');
  });

  it('warns that a rep is on leave', () => {
    // Megha is seeded ON_LEAVE precisely so this path is exercisable (D-19).
    const w = preAssignWarnings(
      rep({ fullName: 'Megha', status: 'ON_LEAVE' }),
      many(5),
      many(5),
    );
    expect(w.find((x) => x.code === 'REP_ON_LEAVE')?.message).toContain('Megha is on leave');
  });

  it('warns about splitting a customer another rep owns', () => {
    // One customer appearing in eight tabs (F1) is how the sheets got that way,
    // and it is also how two reps call the same person on the same day.
    const selected = [
      ...many(3, { ownedByEmployeeId: 'e-riya' }),
      ...many(2).map((l) => ({ ...l, leadId: `x${l.leadId}` })),
    ];
    const w = preAssignWarnings(rep(), selected, selected);
    expect(w.find((x) => x.code === 'EXISTING_CUSTOMER_OWNERSHIP')).toMatchObject({ count: 3 });
  });

  it('does not warn when the customer is already owned by the same rep', () => {
    const selected = many(3, { ownedByEmployeeId: 'e-kajal' });
    expect(
      preAssignWarnings(rep({ employeeId: 'e-kajal' }), selected, selected)
        .find((x) => x.code === 'EXISTING_CUSTOMER_OWNERSHIP'),
    ).toBeUndefined();
  });

  it('warns about ageing leads left in the pool, not just the selection', () => {
    // docs/07 §3: "61 leads in the pool are older than 24 hours — assign these first."
    const pool = [...many(5), ...many(61, { ageHours: AGEING_THRESHOLD_HOURS + 1 })];
    const w = preAssignWarnings(rep(), many(5), pool);
    expect(w.find((x) => x.code === 'AGEING_LEADS_IN_POOL')).toMatchObject({ count: 61 });
  });

  it('warns about leads already past validity', () => {
    // Leads decay. Data Valid Till is a first-class concept the client already has.
    const selected = many(4, { pastValidity: true });
    expect(preAssignWarnings(rep(), selected, selected)
      .find((x) => x.code === 'LEADS_PAST_VALIDITY')).toMatchObject({ count: 4 });
  });

  it('reports several warnings at once, rep-first', () => {
    const selected = many(50, { ownedByEmployeeId: 'e-riya', ageHours: 48 });
    const w = preAssignWarnings(
      rep({ status: 'ON_LEAVE', openLeads: 95, wipCap: 100 }),
      selected,
      selected,
    );
    expect(w.length).toBeGreaterThanOrEqual(3);
    // An admin reads the first line and little else, so the destination rep leads.
    expect(w[0]?.code).toBe('REP_ON_LEAVE');
  });
});

describe('suggestSplit is advisory and always adds up', () => {
  const team: RepSnapshot[] = [
    rep({ employeeId: 'a', fullName: 'Nikita', openLeads: 10, wipCap: 100, yieldPerLead: 800 }),
    rep({ employeeId: 'b', fullName: 'Divya', openLeads: 50, wipCap: 100, yieldPerLead: 400 }),
    rep({ employeeId: 'c', fullName: 'Megha', status: 'ON_LEAVE', yieldPerLead: 900 }),
  ];

  it('proposes exactly the number of leads asked for', () => {
    // An admin told to assign 59 of 60 will not trust the button again.
    for (const n of [1, 7, 60, 137]) {
      const total = suggestSplit(team, n).reduce((s, p) => s + p.leadCount, 0);
      expect(total, `asked for ${n}`).toBe(n);
    }
  });

  it('excludes a rep who is on leave', () => {
    expect(suggestSplit(team, 60).map((p) => p.fullName)).not.toContain('Megha');
  });

  it('gives more to the rep with more headroom and better yield', () => {
    const s = suggestSplit(team, 60);
    const nikita = s.find((p) => p.fullName === 'Nikita')?.leadCount ?? 0;
    const divya = s.find((p) => p.fullName === 'Divya')?.leadCount ?? 0;
    expect(nikita).toBeGreaterThan(divya);
  });

  it('never proposes past a rep WIP cap', () => {
    const tight = [
      rep({ employeeId: 'a', fullName: 'A', openLeads: 98, wipCap: 100, yieldPerLead: 900 }),
      rep({ employeeId: 'b', fullName: 'B', openLeads: 10, wipCap: 100, yieldPerLead: 100 }),
    ];
    for (const p of suggestSplit(tight, 50)) {
      const r = tight.find((x) => x.employeeId === p.employeeId) as RepSnapshot;
      expect(p.leadCount, `${p.fullName} proposed past cap`).toBeLessThanOrEqual(
        r.wipCap - r.openLeads,
      );
    }
  });

  it('still gives leads to a rep with zero yield', () => {
    // A new joiner with no delivered orders last month would otherwise never
    // receive a lead, and so could never build a track record.
    const withNewJoiner = [
      rep({ employeeId: 'a', fullName: 'Nikita', openLeads: 10, yieldPerLead: 800 }),
      rep({ employeeId: 'z', fullName: 'Shweta', openLeads: 0, yieldPerLead: 0 }),
    ];
    const s = suggestSplit(withNewJoiner, 40);
    expect(s.find((p) => p.fullName === 'Shweta')?.leadCount ?? 0).toBeGreaterThan(0);
  });

  it('returns nothing when there is nobody eligible', () => {
    expect(suggestSplit([rep({ status: 'EXITED' })], 10)).toEqual([]);
    expect(suggestSplit([rep({ openLeads: 100, wipCap: 100 })], 10)).toEqual([]);
    expect(suggestSplit(team, 0)).toEqual([]);
  });

  it('stops short rather than overfilling when the team is nearly capped', () => {
    // The admin needs to see the shortfall, not have it hidden by pushing reps
    // past their caps.
    const nearlyFull = [rep({ employeeId: 'a', fullName: 'A', openLeads: 95, wipCap: 100 })];
    const s = suggestSplit(nearlyFull, 50);
    expect(s.reduce((t, p) => t + p.leadCount, 0)).toBe(5);
  });

  it('explains each proposal in terms an admin can check', () => {
    for (const p of suggestSplit(team, 60)) {
      expect(p.reason).toMatch(/slots free/);
      expect(p.reason).toMatch(/yield/);
    }
  });
});

describe('the new-joiner yield floor is relative, not absolute', () => {
  it('scales with the team, so a new rep is never numerically invisible', () => {
    // The first version used an absolute floor of 0.1. Against a team yielding
    // ₹800/lead that is indistinguishable from zero: the new joiner was proposed
    // nothing, so never built a record, so stayed at nothing. Caught by the test
    // above, not by review.
    const highYieldTeam = [
      rep({ employeeId: 'a', fullName: 'Nikita', openLeads: 10, yieldPerLead: 8000 }),
      rep({ employeeId: 'z', fullName: 'Shweta', openLeads: 0, yieldPerLead: 0 }),
    ];
    const s = suggestSplit(highYieldTeam, 40);
    expect(s.find((p) => p.fullName === 'Shweta')?.leadCount ?? 0).toBeGreaterThan(0);
  });

  it('still gives the proven rep the larger share', () => {
    // The floor must not become a subsidy that ignores performance.
    const s = suggestSplit(
      [
        rep({ employeeId: 'a', fullName: 'Nikita', openLeads: 10, wipCap: 100, yieldPerLead: 800 }),
        rep({ employeeId: 'z', fullName: 'Shweta', openLeads: 10, wipCap: 100, yieldPerLead: 0 }),
      ],
      40,
    );
    const proven = s.find((p) => p.fullName === 'Nikita')?.leadCount ?? 0;
    const newJoiner = s.find((p) => p.fullName === 'Shweta')?.leadCount ?? 0;
    expect(proven).toBeGreaterThan(newJoiner);
    expect(newJoiner).toBeGreaterThan(0);
  });

  it('handles a team where nobody has any yield yet', () => {
    // Day one of the pilot: no history at all. Must still distribute.
    const s = suggestSplit(
      [
        rep({ employeeId: 'a', fullName: 'A', openLeads: 0, yieldPerLead: 0 }),
        rep({ employeeId: 'b', fullName: 'B', openLeads: 0, yieldPerLead: 0 }),
      ],
      10,
    );
    expect(s.reduce((t, p) => t + p.leadCount, 0)).toBe(10);
  });
});
