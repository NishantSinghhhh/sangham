import type { Settlement, SettlementStatus } from '../../../packages/shared/src/types.ts';

export type StatusFilter = SettlementStatus | 'all';

export function filterSettlements(items: Settlement[], status: StatusFilter, query: string): Settlement[] {
  const needle = query.trim().toLowerCase();
  return items.filter(s => (status === 'all' || s.status === status) &&
    [s.id, s.merchant, s.hederaTxId, s.payer ?? '', s.payoutRef ?? ''].some(value => value.toLowerCase().includes(needle)));
}

export function ledgerTotals(items: Settlement[]) {
  return {
    // fxRate is stored only after the chain-confirmation stage completes.
    recordedAtomic: items.filter(s => s.fxRate > 0 && !s.hederaTxId.startsWith('sim-')).reduce((sum, s) => sum + BigInt(s.usdcAmount), 0n),
    simulatedAtomic: items.filter(s => s.fxRate > 0 && s.hederaTxId.startsWith('sim-')).reduce((sum, s) => sum + BigInt(s.usdcAmount), 0n),
    mockPayoutPaise: items.filter(s => s.payoutRef && s.payoutMode === 'mock').reduce((sum, s) => sum + (s.payoutPaise ?? 0), 0),
    requestedPayoutPaise: items.filter(s => s.payoutRef && s.payoutMode === 'razorpayx-test').reduce((sum, s) => sum + (s.payoutPaise ?? 0), 0),
    held: items.filter(s => s.status === 'held').length,
  };
}

export function settlementsCsv(items: Settlement[]): string {
  const cell = (value: unknown) => {
    let text = String(value ?? '');
    // Spreadsheet apps can execute cells beginning with formula characters.
    if (/^[\s]*[=+@-]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  const rows: unknown[][] = [['Created', 'Merchant', 'Transaction', 'Status', 'USDC', 'Payout INR', 'Payout mode', 'Reason']];
  for (const s of items) rows.push([s.createdAt, s.merchant, s.hederaTxId, s.status,
    (Number(s.usdcAmount) / 1e6).toFixed(6), s.payoutRef ? ((s.payoutPaise ?? 0) / 100).toFixed(2) : '', s.payoutMode, s.error ?? s.decisionReason]);
  return rows.map(row => row.map(cell).join(',')).join('\r\n');
}
