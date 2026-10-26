# Settlement workspace

The dashboard uses vanilla TypeScript, semantic HTML, and CSS. No runtime dependencies were added.

## Design

Warm ledger-paper surfaces, forest-green actions, and a USDC-to-INR corridor distinguish the settlement service from a generic crypto portfolio. The left navigation links to actual page sections. Financial numbers use tabular figures, and the layout adapts to narrow screens without hiding settlement evidence.

The workflow was guided by [Interface Design](https://github.com/Dammyjay93/interface-design/blob/main/.claude/skills/interface-design/SKILL.md) and reviewed against [Vercel Web Interface Guidelines](https://github.com/vercel-labs/web-interface-guidelines/blob/main/command.md). Those skills were read for this change, not installed as application dependencies.

## Behaviour

- Search full merchant, payer, settlement, transaction, and payout-reference values. Combine search with status filters.
- Export the currently filtered records to CSV. Text cells escape CSV delimiters and neutralise spreadsheet formula prefixes.
- Simulate a normal payment or a 10% underpayment when the settlement service has chain verification disabled.
- Simulation explicitly marks discovery, invoice, and transfer as skipped. It does not imply those events occurred.
- Simulated transfer totals remain separate from non-simulation records even after a service mode change. Payout references are separated into mock and requested values; neither implies bank completion.
- Polling preserves search controls and avoids replacing unchanged table contents. Hidden tabs stop issuing polling requests.
- Service failure retains previous records with a warning; first-load failure displays a waiting state. Refresh retries settlement, merchant, and invoice requests.
- Native links, buttons, and disclosures provide keyboard access. Scrollable ledger and invoice regions are focusable. Reduced-motion preferences disable smooth scrolling and transitions.

## Checks

```sh
npm run typecheck
npm --workspace @sangam/dashboard run build
npm --workspace @sangam/dashboard test
```

The tests use Node 22's built-in test runner and TypeScript stripping; no additional test framework is required.

Manually exercised in the local browser: full and underpayment simulations, search, status filters, no-results state, CSV download, invoice disclosure, keyboard focus, and service outage/recovery. Checked desktop and a 390px viewport: only the ledger scrolls horizontally; the page itself fits. These checks do not establish full accessibility compliance or verify real financial integrations.

## Community reference

[Making Scrollable Code Blocks Accessible](https://dev.to/th3s4mur41/making-scrollable-code-blocks-accessible-3i0o) by [Michaël Vanderheyden](https://dev.to/th3s4mur41) discusses why overflowing regions should receive keyboard focus. The ledger wrapper and invoice code block explicitly use `tabindex="0"` for that reason.
