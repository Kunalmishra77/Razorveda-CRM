import { describe, it, expect } from 'vitest';
import {
  applyActivityToLead, storedRemark, validateActivity,
  type ActivityInput, type DispositionRule, type LeadState,
} from '../src/activity/log-activity.js';

const followUp: DispositionRule = {
  dispositionId: 'd-followup',
  code: 'FOLLOW_UP',
  requiresFollowupDate: true,
  countsAsConnect: true,
  isTerminal: false,
};
const ringing: DispositionRule = {
  dispositionId: 'd-ringing',
  code: 'RINGING',
  requiresFollowupDate: false,
  countsAsConnect: false,
  isTerminal: false,
};
const orderDone: DispositionRule = {
  dispositionId: 'd-order',
  code: 'ORDER_DONE',
  requiresFollowupDate: false,
  countsAsConnect: true,
  isTerminal: true,
};

const call = (over: Partial<ActivityInput> = {}): ActivityInput => ({
  leadId: 'l1',
  type: 'CALL',
  dispositionId: ringing.dispositionId,
  remarkRaw: null,
  followupAt: null,
  connected: false,
  ...over,
});

const fresh: LeadState = {
  contactAttempts: 0,
  everConnected: false,
  firstContactAt: null,
  firstConnectedAt: null,
  lastContactAt: null,
  nextFollowupAt: null,
  currentDispositionId: null,
  closedAt: null,
};

const T1 = '2026-08-21T10:00:00.000Z';
const T2 = '2026-08-21T11:00:00.000Z';
const T3 = '2026-08-22T10:00:00.000Z';

describe('disposition is mandatory — enforced by the API, not just the UI', () => {
  it('rejects a call with no disposition', () => {
    // F4: 49 spellings of ~12 outcomes exist because the field was free text. A
    // closed vocabulary the server does not enforce is a free-text field with a
    // nicer widget.
    const v = validateActivity(call({ dispositionId: null }), null);
    expect(v).toMatchObject({ ok: false, field: 'dispositionId' });
    if (!v.ok) expect(v.message).toMatch(/choose an outcome/i);
  });

  it('rejects a disposition that is not in the closed list', () => {
    expect(validateActivity(call({ dispositionId: 'made-up' }), null)).toMatchObject({
      ok: false,
      field: 'dispositionId',
    });
  });

  it('does not demand one for a NOTE', () => {
    expect(validateActivity(call({ type: 'NOTE', dispositionId: null }), null)).toEqual({ ok: true });
  });

  it('demands a follow-up date when the disposition says so', () => {
    const v = validateActivity(call({ dispositionId: followUp.dispositionId }), followUp);
    expect(v).toMatchObject({ ok: false, field: 'followupAt' });
    // Says what happened and what to do next (docs/07 §5).
    if (!v.ok) expect(v.message).toContain('FOLLOW_UP');
  });

  it('accepts it once the date is supplied', () => {
    expect(
      validateActivity(
        call({ dispositionId: followUp.dispositionId, followupAt: T3 }),
        followUp,
      ),
    ).toEqual({ ok: true });
  });

  it('does not demand a date for a disposition that does not need one', () => {
    expect(validateActivity(call(), ringing)).toEqual({ ok: true });
  });

  it('rejects an unparseable follow-up date', () => {
    expect(validateActivity(call({ followupAt: 'tomorrow' }), ringing)).toMatchObject({
      ok: false,
      field: 'followupAt',
    });
  });
});

describe('first_connected_at — the B5 defect, pinned', () => {
  it('is NOT set by an unconnected attempt, though first_contact_at is', () => {
    // Contact is an attempt; connect is a conversation. Substituting one for the
    // other silently inflates CD, which the client reads daily.
    const after = applyActivityToLead(fresh, call({ connected: false }), ringing, T1);
    expect(after.firstContactAt).toBe(T1);
    expect(after.firstConnectedAt).toBeNull();
    expect(after.everConnected).toBe(false);
  });

  it('is set on the first connected contact', () => {
    const attempt = applyActivityToLead(fresh, call({ connected: false }), ringing, T1);
    const connectedCall = applyActivityToLead(
      attempt,
      call({ connected: true, dispositionId: followUp.dispositionId, followupAt: T3 }),
      followUp,
      T2,
    );
    expect(connectedCall.firstContactAt).toBe(T1); // unchanged
    expect(connectedCall.firstConnectedAt).toBe(T2);
    expect(connectedCall.everConnected).toBe(true);
  });

  it('is never overwritten by a later connect', () => {
    const first = applyActivityToLead(
      fresh,
      call({ connected: true, dispositionId: followUp.dispositionId, followupAt: T3 }),
      followUp,
      T1,
    );
    const second = applyActivityToLead(
      first,
      call({ connected: true, dispositionId: followUp.dispositionId, followupAt: T3 }),
      followUp,
      T2,
    );
    // Today's CD counts leads whose FIRST connect was today. Overwriting would
    // re-count an old lead as new every time the rep called again.
    expect(second.firstConnectedAt).toBe(T1);
  });

  it('does not trust connected=true against a not-connected disposition', () => {
    // "Ringing" with connected ticked is a mis-click, not a conversation. The
    // disposition is the closed vocabulary; the checkbox is self-reported.
    const after = applyActivityToLead(fresh, call({ connected: true }), ringing, T1);
    expect(after.everConnected).toBe(false);
    expect(after.firstConnectedAt).toBeNull();
  });
});

describe('Fq — contact_attempts counts attempts, not rows', () => {
  it('increments on each contact attempt', () => {
    let s = applyActivityToLead(fresh, call(), ringing, T1);
    s = applyActivityToLead(s, call(), ringing, T2);
    expect(s.contactAttempts).toBe(2);
    expect(s.lastContactAt).toBe(T2);
  });

  it('does NOT increment for a NOTE', () => {
    // Frequency is a real metric in the client's MIS, not a row counter.
    const s = applyActivityToLead(fresh, call({ type: 'NOTE', dispositionId: null }), null, T1);
    expect(s.contactAttempts).toBe(0);
    expect(s.firstContactAt).toBeNull();
  });

  it('lets a NOTE still set a follow-up', () => {
    const s = applyActivityToLead(
      fresh,
      call({ type: 'NOTE', dispositionId: null, followupAt: T3 }),
      null,
      T1,
    );
    expect(s.nextFollowupAt).toBe(T3);
  });
});

describe('terminal dispositions close the lead', () => {
  it('clears the follow-up and stamps closed_at', () => {
    // 174 of the client's leads sat with a rep for a full validity window
    // producing nothing. A closed lead must stop appearing in the worklist.
    const withFollowup = applyActivityToLead(
      fresh,
      call({ dispositionId: followUp.dispositionId, connected: true, followupAt: T3 }),
      followUp,
      T1,
    );
    expect(withFollowup.nextFollowupAt).toBe(T3);

    const closed = applyActivityToLead(
      withFollowup,
      call({ dispositionId: orderDone.dispositionId, connected: true }),
      orderDone,
      T2,
    );
    expect(closed.nextFollowupAt).toBeNull();
    expect(closed.closedAt).toBe(T2);
    expect(closed.currentDispositionId).toBe(orderDone.dispositionId);
  });

  it('keeps the original closed_at if another activity lands after closing', () => {
    const closed = applyActivityToLead(
      fresh,
      call({ dispositionId: orderDone.dispositionId, connected: true }),
      orderDone,
      T1,
    );
    const later = applyActivityToLead(
      closed,
      call({ dispositionId: orderDone.dispositionId, connected: true }),
      orderDone,
      T2,
    );
    expect(later.closedAt).toBe(T1);
  });
});

describe('remark_raw is stored verbatim', () => {
  it('does not touch Hinglish, case or spelling', () => {
    // Four months of these are the raw material for Phase 6 objection
    // intelligence. Normalising on the way in destroys the evidence.
    const raw = 'abhi product hai baad mei lungi, husband se puchna padega';
    expect(storedRemark(raw)).toBe(raw);
  });

  it('preserves Devanagari and emoji rather than stripping them', () => {
    expect(storedRemark('मोहन ने कहा ठीक है ❤️')).toBe('मोहन ने कहा ठीक है ❤️');
  });

  it('preserves internal spacing and punctuation', () => {
    expect(storedRemark('amount  issue h... 2500 zyada hai')).toBe(
      'amount  issue h... 2500 zyada hai',
    );
  });

  it('trims only trailing whitespace, and empties to null', () => {
    expect(storedRemark('ringing   ')).toBe('ringing');
    expect(storedRemark('   ')).toBeNull();
    expect(storedRemark(null)).toBeNull();
  });
});
