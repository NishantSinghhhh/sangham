/// <reference types="vite/client" />
import type { Settlement } from '../../../packages/shared/src/types.ts';
import { filterSettlements, ledgerTotals, settlementsCsv, type StatusFilter } from './ledger.ts';

const API = import.meta.env.VITE_SETTLEMENT_URL || '/api';
const MERCHANT = import.meta.env.VITE_MERCHANT_URL || '/merchant';

type Stats = {
  ogBalance: string | null;
  hcsTopicId: string | null;
  mocks: { og: boolean; psp: boolean; chainVerify: boolean; ens: boolean };
};
type Quote = { merchant: string; priceInr: number; priceUsdc: string; network: string; payTo: string; upiHandle: string };
type Invoice = { accepts: { amount: string; asset: string; payTo: string; network: string; maxTimeoutSeconds: number; extra?: { feePayer?: string } }[] };
type StepState = 'done' | 'active' | 'warn' | 'fail' | 'todo';

const icons: Record<string, string> = {
  overview: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  merchant: '<path d="M3 10l2-6h14l2 6M4 10v10h16V10M9 20v-6h6v6M3 10c0 3 5 3 5 0 0 3 4 3 4 0 0 3 4 3 4 0 0 3 5 3 5 0"/>',
  invoice: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3zM9 7h6M9 11h6M9 15h3"/>',
  code: '<path d="M8 6l-6 6 6 6M16 6l6 6-6 6M14 3l-4 18"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-2l2 3M4 16l2 3a7 7 0 0 0 12-2"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
  layers: '<path d="M12 3L2 8l10 5 10-5-10-5zM2 12l10 5 10-5M2 16l10 5 10-5"/>',
  play: '<path d="M8 4l12 8-12 8V4z"/>',
  train: '<rect x="5" y="3" width="14" height="16" rx="4"/><path d="M5 10h14M12 3v7M8 15h.01M16 15h.01M8 19l-2 3M16 19l2 3"/>',
  arrow: '<path d="M4 12h16M15 7l5 5-5 5"/>',
  shield: '<path d="M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3zM8 12l3 3 5-6"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M4 16v5h16v-5"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M16 16l5 5"/>',
  check: '<path d="M5 12l4 4L19 6"/>',
};
const icon = (name: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] ?? icons.info}</svg>`;
document.querySelectorAll<HTMLElement>('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon!); });
const $ = (id: string) => document.getElementById(id)!;
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const usdc = (atomic: string | bigint, dp = 4) => (Number(atomic) / 1e6).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
const rupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const short = (value: string, length = 12) => value.length > length + 8 ? `${value.slice(0, length)}…${value.slice(-6)}` : value;
const dateTime = new Intl.DateTimeFormat('en-IN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

let items: Settlement[] = [];
let stats: Stats | null = null;
let statusFilter: StatusFilter = 'all';
let searchQuery = '';
let currentMerchant: string | null = null;
let simulationBusy = false;
let pollBusy = false;
let hasLoaded = false;
let lastLedgerMarkup = '';
let lastFlowMarkup = '';
let simulationMode: boolean | null = null;

const STEPS = [
  { who: 'DISCOVER', title: 'Find merchant', detail: 'ENS name resolves the shop and payment details.' },
  { who: 'REQUEST', title: 'Read invoice', detail: 'The merchant replies with an x402 payment request.' },
  { who: 'PAY', title: 'Transfer USDC', detail: 'A signed payment credits the Hedera treasury.' },
  { who: 'EVALUATE', title: 'Check & decide', detail: 'Verify the transfer, then approve or hold.' },
  { who: 'SETTLE', title: 'Request INR', detail: 'Request a payout and record a receipt if configured.' },
];

function stepStates(s: Settlement | undefined): StepState[] {
  if (!s) return ['todo', 'todo', 'todo', 'todo', 'todo'];
  // Simulation begins with a notice: discovery, invoice, and transfer did not run.
  const first: StepState[] = s.hederaTxId.startsWith('sim-') ? ['todo', 'todo', 'todo'] : ['done', 'done', 'done'];
  if (s.status === 'held') return [...first, 'warn', 'todo'];
  if (s.status === 'failed') return [...first, s.decision ? 'done' : 'fail', s.decision ? 'fail' : 'todo'];
  if (s.status === 'paid') return [...first, 'done', 'done'];
  if (s.status === 'decided') return [...first, 'done', 'active'];
  return [...first, 'active', 'todo'];
}

function statusLabel(s: Settlement) {
  if (s.status === 'paid') return s.payoutMode === 'mock' ? 'Demo payout' : 'Requested';
  return ({ received: 'Received', confirmed: 'Confirmed', decided: 'Decided', held: 'Held', failed: 'Failed' })[s.status];
}

function renderFlow(latest: Settlement | undefined) {
  const states = stepStates(latest);
  const simulated = latest?.hederaTxId.startsWith('sim-');
  const markup = STEPS.map((step, i) => `<li class="step ${states[i]}"><div class="step-marker"><span class="num">${states[i] === 'done' ? icon('check') : String(i + 1).padStart(2, '0')}</span></div><span class="who">${step.who}${simulated && i < 3 ? ' · SKIPPED' : ''}</span><span class="title">${step.title}</span><span class="detail">${step.detail}</span></li>`).join('');
  if (markup !== lastFlowMarkup) { $('flow').innerHTML = markup; lastFlowMarkup = markup; }
  $('latest-status').textContent = latest ? statusLabel(latest) : 'Awaiting payment';
  if (!latest) return;
  const outcome = latest.status === 'paid'
    ? `${latest.payoutMode === 'mock' ? 'simulated payout' : 'payout requested'} ${rupees(latest.payoutPaise ?? 0)}`
    : latest.status === 'held' ? 'held for review' : latest.status === 'failed' ? `failed: ${latest.error ?? 'unknown error'}` : 'settlement in progress…';
  $('flow-caption').textContent = `${simulated ? 'Simulation · first three steps bypassed' : 'Latest payment'} · ${usdc(latest.usdcAmount)} USDC · ${outcome}${latest.hcsSequence !== null ? ` · HCS receipt #${latest.hcsSequence}` : ''}`;
}

function renderStats(s: Stats) {
  const totals = ledgerTotals(items);
  $('count').textContent = String(items.length);
  $('nav-count').textContent = String(items.length);
  $('activity-count').textContent = String(items.length);
  const showSimulation = s.mocks.chainVerify && totals.recordedAtomic === 0n;
  $('usdc').textContent = usdc(showSimulation ? totals.simulatedAtomic : totals.recordedAtomic);
  $('usdc-label').textContent = showSimulation ? 'Simulated USDC' : 'Recorded USDC';
  $('usdc-note').textContent = showSimulation ? 'Simulation · chain verification skipped'
    : totals.simulatedAtomic > 0n ? `${usdc(totals.simulatedAtomic)} demo USDC excluded` : 'Recorded after confirmation stage · see evidence';
  const hasMockPayouts = totals.mockPayoutPaise > 0;
  const hasRequestedPayouts = totals.requestedPayoutPaise > 0;
  $('payout-label').textContent = hasRequestedPayouts ? 'Payout requests' : s.mocks.psp ? 'Demo payouts' : 'Payout requests';
  $('inr').textContent = rupees(hasRequestedPayouts ? totals.requestedPayoutPaise : totals.mockPayoutPaise);
  $('payout-note').textContent = hasRequestedPayouts
    ? `Not bank-confirmed${hasMockPayouts ? ` · ${rupees(totals.mockPayoutPaise)} demo separately` : ''}`
    : s.mocks.psp || hasMockPayouts ? 'Simulated amount · no rupees moved' : 'Bank completion is not tracked';
  $('held-count').textContent = String(totals.held);
  $('og').textContent = s.mocks.og ? 'Mock mode' : s.ogBalance === null ? 'Unavailable' : Number(s.ogBalance).toFixed(4);
  $('og-note').textContent = s.mocks.og ? 'Local rules · no compute credits spent' : s.ogBalance === null ? 'Could not read the provider ledger' : 'OG available in compute ledger';
  $('mode-title').textContent = s.mocks.chainVerify ? 'You’re in simulation mode' : 'Hedera testnet workspace';
  $('mode-description').textContent = s.mocks.chainVerify ? 'Demo notices only. No USDC transfer is submitted.' : 'Test tokens only. Check the service modes before presenting.';
  $('mocks').innerHTML = [s.mocks.og && '0G mocked', s.mocks.psp && 'UPI mocked', s.mocks.chainVerify && 'Chain check off', s.mocks.ens && 'ENS offline'].filter(Boolean).map(label => `<span>${label}</span>`).join('');
}

function renderTry(s: Stats) {
  $('try-note').textContent = s.mocks.chainVerify ? 'Send a simulated payment and watch the settlement unfold.' : 'Use the buyer CLI to make a testnet purchase.';
  $('demo-disclaimer').textContent = s.mocks.chainVerify ? 'Simulation skips purchase and chain check' : 'Fictional tickets · testnet only';
  if (simulationMode === s.mocks.chainVerify) return;
  simulationMode = s.mocks.chainVerify;
  if (s.mocks.chainVerify) {
    $('try-actions').innerHTML = `<button id="sim-ok" class="button primary">${icon('play')}Simulate a payment <span aria-hidden="true">→</span></button><button id="sim-short" class="text-button">Try an underpayment <span aria-hidden="true">↗</span></button>`;
    $('sim-ok').addEventListener('click', () => simulate(false));
    $('sim-short').addEventListener('click', () => simulate(true));
  } else {
    $('try-actions').innerHTML = `<code>npm run buy -- --merchant ${esc(currentMerchant ?? 'tickets.sangam.eth')} --count 3</code>`;
  }
}

async function simulate(underpay: boolean) {
  if (simulationBusy) return;
  simulationBusy = true;
  const buttons = document.querySelectorAll<HTMLButtonElement>('#try-actions button');
  buttons.forEach(button => { button.disabled = true; });
  const feedback = $('simulation-feedback');
  feedback.classList.remove('error');
  feedback.textContent = 'Sending a demo notice…';
  try {
    const res = await fetch(`${API}/dev/simulate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ short: underpay }), signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`The simulation returned HTTP ${res.status}.`);
    feedback.textContent = underpay ? 'Underpayment received. Watch for a hold decision below.' : 'Demo notice received. Follow its journey below.';
    await tick();
  } catch (error) {
    feedback.classList.add('error');
    feedback.textContent = `Couldn’t send the demo. ${(error as Error).message} Try again.`;
  } finally {
    simulationBusy = false;
    buttons.forEach(button => { button.disabled = false; });
  }
}

function renderRows() {
  const visible = filterSettlements(items, statusFilter, searchQuery);
  $('result-count').textContent = `Showing ${visible.length} of ${items.length} ${items.length === 1 ? 'record' : 'records'}`;
  const markup = visible.length ? visible.map(s => {
    const simulated = s.hederaTxId.startsWith('sim-');
    const proof = [
      simulated ? '<code>Simulated transfer</code>' : `<a href="https://hashscan.io/testnet/transaction/${encodeURIComponent(s.hederaTxId)}" target="_blank" rel="noopener noreferrer">USDC transaction ↗</a>`,
      s.payoutRef ? `<code title="${esc(s.payoutRef)}">${s.payoutMode === 'mock' ? 'Mock' : 'Payout'} ${esc(short(s.payoutRef, 8))}</code>` : '',
      s.hcsSequence !== null && stats?.hcsTopicId ? `<a href="https://hashscan.io/testnet/topic/${encodeURIComponent(stats.hcsTopicId)}" target="_blank" rel="noopener noreferrer">HCS #${s.hcsSequence} ↗</a>` : '',
    ].join('');
    return `<tr><td><div class="tx-cell"><span class="tx-symbol">${icon('arrow')}</span><div><strong>${esc(s.merchant)}</strong><small>${dateTime.format(new Date(s.createdAt))}</small><small title="${esc(s.hederaTxId)}">${esc(short(s.hederaTxId))}</small></div></div></td>
      <td class="amount">${usdc(s.usdcAmount)}<span class="cell-note">${simulated ? 'SIMULATED USDC' : s.fxRate > 0 ? 'USDC · RECORDED' : 'USDC · UNVERIFIED'}</span></td>
      <td class="amount">${s.payoutRef ? rupees(s.payoutPaise ?? 0) : '—'}<span class="cell-note">${s.payoutRef ? s.payoutMode === 'mock' ? 'DEMO PAYOUT' : 'REQUESTED' : 'NO PAYOUT'}</span></td>
      <td><span class="pill ${esc(s.status)}">${esc(statusLabel(s))}</span></td>
      <td><div class="decision-text">${esc(s.error ?? s.decisionReason ?? 'Awaiting settlement decision…')}${s.feeBps !== null ? `<small>${(s.feeBps / 100).toFixed(2)}% fee${s.ogChatId ? ` · ${esc(short(s.ogChatId, 7))}` : ''}</small>` : ''}</div></td>
      <td><div class="proof">${proof}</div></td></tr>`;
  }).join('') : `<tr><td colspan="6" class="empty"><strong>${items.length ? 'No matching payments' : 'Your first payment starts here'}</strong>${items.length ? 'Try a different search or select All payments.' : 'Simulate a payment above, or run the buyer in testnet mode.'}</td></tr>`;
  // Avoid replacing focused evidence links every second when the data is unchanged.
  if (markup !== lastLedgerMarkup) { $('rows').innerHTML = markup; lastLedgerMarkup = markup; }
}

async function loadMerchant() {
  try {
    const res = await fetch(`${MERCHANT}/quote`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const q = await res.json() as Quote;
    currentMerchant = q.merchant;
    $('ticket-price').textContent = `₹${q.priceInr}`;
    $('merchant').innerHTML = `<div class="merchant-identity"><div class="merchant-avatar">${icon('train')}</div><div><strong>${esc(q.merchant)}</strong><span>Rail ticket demo · ENS merchant record</span></div></div><dl class="facts"><dt>Ticket price</dt><dd><span class="price">₹${esc(q.priceInr)}</span><small>≈ ${esc(q.priceUsdc)} USDC at quote time</small></dd><dt>USDC treasury</dt><dd><code>${esc(q.payTo)}</code><small>${esc(q.network)}</small></dd><dt>UPI destination</dt><dd><code>${esc(q.upiHandle)}</code><small>Merchant’s configured payout handle</small></dd></dl>`;
    if (simulationMode === false) { simulationMode = null; if (stats) renderTry(stats); }
  } catch {
    $('merchant').innerHTML = '<p class="muted">Merchant unavailable. Start the merchant service, then select Refresh.</p>';
  }
}

async function loadInvoice() {
  try {
    const res = await fetch(`${MERCHANT}/book?from=CSMT&to=PUNE`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    const header = res.headers.get('PAYMENT-REQUIRED');
    if (res.status !== 402 || !header) throw new Error(`Expected an x402 invoice; received HTTP ${res.status}.`);
    const bytes = Uint8Array.from(atob(header), c => c.charCodeAt(0));
    const invoice = JSON.parse(new TextDecoder().decode(bytes)) as Invoice;
    const a = invoice.accepts[0];
    if (!a) throw new Error('The merchant returned no payment options.');
    $('invoice').innerHTML = `<dt>Requested amount</dt><dd><span class="price">${usdc(a.amount, 6)}</span> USDC</dd><dt>Network</dt><dd><code>${esc(a.network)}</code></dd><dt>Token / recipient</dt><dd><code>${esc(a.asset)} / ${esc(a.payTo)}</code></dd><dt>Network fee payer</dt><dd><code>${esc(a.extra?.feePayer ?? 'Not specified')}</code><small>Provided by the facilitator</small></dd><dt>Payment timeout</dt><dd>${esc(a.maxTimeoutSeconds)} seconds</dd>`;
    $('invoice-raw').textContent = JSON.stringify(invoice, null, 2);
  } catch (error) {
    $('invoice').innerHTML = `<dt>Unavailable</dt><dd>${esc((error as Error).message)} Select Refresh to retry.</dd>`;
    $('invoice-raw').textContent = 'No current invoice available.';
  }
}

async function tick() {
  if (pollBusy) return;
  pollBusy = true;
  try {
    const [statsRes, itemsRes] = await Promise.all([fetch(`${API}/stats`, { signal: AbortSignal.timeout(8000) }), fetch(`${API}/settlements`, { signal: AbortSignal.timeout(8000) })]);
    if (!statsRes.ok || !itemsRes.ok) throw new Error('Settlement service returned an error.');
    [stats, items] = await Promise.all([statsRes.json() as Promise<Stats>, itemsRes.json() as Promise<Settlement[]>]);
    hasLoaded = true;
    $('connection').textContent = 'Service connected';
    $('connection').className = 'connection connected';
    $('service-error').hidden = true;
    renderStats(stats); renderTry(stats); renderFlow(items[0]); renderRows();
    ($('export') as HTMLButtonElement).disabled = items.length === 0;
  } catch {
    $('connection').textContent = 'Service offline';
    $('connection').className = 'connection offline';
    $('service-error').hidden = false;
    $('service-error').textContent = `Settlement service unavailable. ${hasLoaded ? 'Showing the last received records.' : 'Start npm run settlement:sim to try the demo.'} Retrying automatically.`;
    if (!hasLoaded) {
      $('mode-title').textContent = 'Settlement service unavailable';
      $('mode-description').textContent = 'Service modes could not be checked.';
      $('rows').innerHTML = '<tr><td colspan="6" class="empty"><strong>Waiting for the settlement service</strong>Start the service, then select Refresh.</td></tr>';
      // A direct placeholder replacement must not suppress the first recovery render.
      lastLedgerMarkup = '';
    }
    document.querySelectorAll<HTMLButtonElement>('#try-actions button').forEach(button => { button.disabled = true; });
  } finally { pollBusy = false; }
  if (!simulationBusy && $('connection').classList.contains('connected')) document.querySelectorAll<HTMLButtonElement>('#try-actions button').forEach(button => { button.disabled = false; });
}

document.querySelectorAll<HTMLButtonElement>('[data-status]').forEach(button => button.addEventListener('click', () => {
  statusFilter = button.dataset.status as StatusFilter;
  document.querySelectorAll<HTMLButtonElement>('[data-status]').forEach(el => { const selected = el === button; el.classList.toggle('active', selected); el.setAttribute('aria-pressed', String(selected)); });
  renderRows();
}));
$('search').addEventListener('input', event => { searchQuery = (event.target as HTMLInputElement).value; renderRows(); });
$('export').addEventListener('click', () => {
  const csv = settlementsCsv(filterSettlements(items, statusFilter, searchQuery));
  const url = URL.createObjectURL(new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8;' }));
  const link = document.createElement('a'); link.href = url; link.download = `sangam-settlements-${new Date().toISOString().slice(0, 10)}.csv`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$('refresh').addEventListener('click', async () => {
  const button = $('refresh') as HTMLButtonElement;
  button.disabled = true;
  await Promise.all([tick(), loadMerchant(), loadInvoice()]);
  button.disabled = false;
});

// Navigation remains real anchor links; observer only reflects the visible section.
const navLinks = document.querySelectorAll<HTMLAnchorElement>('.nav-links a');
const observer = new IntersectionObserver(entries => {
  const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
  if (!visible) return;
  navLinks.forEach(link => { const active = link.hash === `#${visible.target.id}`; link.classList.toggle('active', active); if (active) link.setAttribute('aria-current', 'location'); else link.removeAttribute('aria-current'); });
}, { rootMargin: '-10% 0px -45% 0px' });
navLinks.forEach(link => { const section = document.querySelector(link.hash); if (section) observer.observe(section); });
const howItWorks = $('how-it-works') as HTMLDetailsElement;
document.querySelector<HTMLAnchorElement>('.corridor-foot a')!.addEventListener('click', () => { howItWorks.open = true; });
($('refresh') as HTMLButtonElement).setAttribute('aria-label', 'Refresh payment data');
($('export') as HTMLButtonElement).disabled = true;
renderFlow(undefined);
void loadMerchant(); void loadInvoice(); void tick();
setInterval(() => { if (!document.hidden) void tick(); }, 1000);
setInterval(() => { if (!document.hidden) void loadInvoice(); }, 30000);
