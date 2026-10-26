import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Settlement } from '../../../packages/shared/src/types.ts';
import { filterSettlements, ledgerTotals, settlementsCsv } from './ledger.ts';

const row = (patch: Partial<Settlement> = {}): Settlement => ({
  id: 'one', merchant: 'tickets.sangam.eth', hederaTxId: 'real-one', payer: '0.0.1001',
  usdcAmount: '500000', fxRate: 98, inrGrossPaise: 4900, feeBps: 50,
  payoutPaise: 4875, decision: 'payout', decisionReason: 'Routine payment',
  ogChatId: 'mock-chat', ogVerified: null, payoutRef: 'mock-ref', payoutMode: 'mock',
  hcsSequence: null, status: 'paid', error: null,
  createdAt: '2026-10-26T00:00:00Z', updatedAt: '2026-10-26T00:00:00Z', ...patch,
});

test('search combines with status and matches full payer, merchant, and transaction IDs', () => {
  const rows = [row(), row({ id: 'two', status: 'held', merchant: 'Food.Shop.eth', hederaTxId: 'tx-two' })];
  assert.deepEqual(filterSettlements(rows, 'held', ' FOOD ').map(r => r.id), ['two']);
  assert.equal(filterSettlements(rows, 'paid', 'food').length, 0);
  assert.equal(filterSettlements(rows, 'all', '0.0.1001').length, 2);
  assert.equal(filterSettlements(rows, 'all', 'tx-two').length, 1);
});

test('totals exclude unconfirmed notices and separate mock from requested payouts', () => {
  const totals = ledgerTotals([
    row(), row({ id: 'live', payoutMode: 'razorpayx-test', payoutPaise: 4000 }),
    row({ id: 'waiting', fxRate: 0, status: 'received', usdcAmount: '999999999', payoutRef: null, payoutMode: null }),
    row({ id: 'held', status: 'held', payoutRef: null }),
    row({ id: 'failed-receipt', status: 'failed', payoutMode: 'razorpayx-test', payoutPaise: 1000 }),
  ]);
  assert.equal(totals.recordedAtomic, 2000000n);
  assert.equal(totals.mockPayoutPaise, 4875);
  // A receipt failure must not erase an already accepted payout request.
  assert.equal(totals.requestedPayoutPaise, 5000);
  assert.equal(totals.held, 1);
});

test('persisted simulation records never inflate non-simulation totals', () => {
  const totals = ledgerTotals([row(), row({ id: 'sim', hederaTxId: 'sim-one', usdcAmount: '700000' })]);
  assert.equal(totals.recordedAtomic, 500000n);
  assert.equal(totals.simulatedAtomic, 700000n);
});

test('CSV escapes quotes and newlines and neutralises spreadsheet formula injection', () => {
  const csv = settlementsCsv([row({ merchant: '=HYPERLINK("bad")', decisionReason: 'A, B\n"review"' })]);
  assert.ok(csv.includes('"\'=HYPERLINK(""bad"")"'));
  assert.ok(csv.includes('"A, B\n""review"""'));
  assert.ok(csv.includes('mock'));
  assert.ok(settlementsCsv([]).startsWith('"Created"'));
});
