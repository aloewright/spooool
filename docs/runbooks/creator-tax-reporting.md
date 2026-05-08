# Creator income reporting (Polar Merchant of Record)

Status: design doc — Spooool's creator monetization runs through Polar. Polar
acts as Merchant of Record (MoR), so Polar collects and remits sales tax / VAT
on customer purchases. Spooool does **not** integrate Stripe Tax.

This document covers the *creator-side* tax workflow: how earnings are tracked,
where creators retrieve year-end forms, and the open question of who issues
US 1099-Ks for the partner program.

## Roles

- **Polar (Merchant of Record)** — sells subscriptions / one-off purchases to
  end customers, collects sales tax & VAT, remits to tax authorities, owns the
  customer-facing tax invoice.
- **Spooool** — runs the creator partner program. Polar pays Spooool a single
  net amount (gross sales minus Polar fees, refunds, and remitted taxes).
  Spooool then pays creators their share via Polar's partner-payout flow.
- **Creator** — receives partner payouts. Responsible for reporting that
  income to their own tax authority. Spooool surfaces totals and links to the
  appropriate Polar-issued documents.

## What Polar provides today

Polar's docs (https://docs.polar.sh) describe the following partner / payee
tax artifacts:

- **EU/UK creators** — Polar issues a self-billing invoice or equivalent
  payout statement per payout cycle. VAT handling depends on whether the
  creator is VAT-registered (B2B reverse charge) or a private individual.
- **US creators** — Polar collects W-9 information at onboarding for US
  payees. Polar's roadmap includes 1099-MISC / 1099-NEC issuance for partner
  payouts above the IRS threshold ($600 for 1099-NEC; $5,000 for 1099-K in
  TY2024, scheduled to drop to $2,500 for TY2025 and $600 for TY2026 under
  current IRS guidance).
- **Non-US, non-EU creators** — Polar collects W-8BEN / W-8BEN-E equivalents
  and applies treaty withholding where applicable.

## 1099-K gap (US creators)

**Open question:** Polar's partner-payout product is newer than its core
checkout. As of writing, Polar has not publicly committed to issuing
**1099-Ks** for Spooool's partner program — only 1099-NEC for direct
contractor payouts.

Two paths if Polar does not issue 1099-Ks in time for the relevant tax year:

1. **Defer to Polar's roadmap.** Track Polar's product updates; communicate
   the timing to creators in-app and via email. Lowest engineering cost.
2. **Issue 1099-Ks via Track1099 (or similar).** Spooool exports payout
   totals per US creator from Polar, hands them to Track1099 for e-filing
   with the IRS and recipient delivery. Requires:
   - Per-payout records persisted in Spooool's D1 (`creator_payouts` table,
     not yet built).
   - W-9 capture flow for US creators (Polar already collects this; we may
     need a copy or a Polar API pull).
   - Annual export job (Workers cron) to push to Track1099's API.

**Recommendation:** start with path (1) and re-evaluate in Q3 of each tax
year once Polar's plan is confirmed. Keep `creator_payouts` schema work
behind a feature flag so we can flip to path (2) without a long lead time.

## Creator dashboard (planned)

When the Polar integration lands, the creator dashboard should surface:

- **Year-to-date earnings** — sum of net partner payouts in the current
  calendar year, in the creator's payout currency.
- **Per-payout history** — date, gross amount, Polar fees, net to creator,
  link to Polar's payout statement.
- **Tax documents** — links into Polar's dashboard for any W-9 / W-8 /
  1099 / payout statements Polar has issued, plus (if path 2) any
  Spooool-issued 1099-Ks via Track1099's recipient portal.

Until the Polar partner integration is wired up, Account Settings links
creators directly to Polar's tax-form documentation so they can find their
records there.

## References

- Polar tax docs: https://docs.polar.sh/merchant-of-record/tax
- Polar partner payouts: https://docs.polar.sh/features/partner-payouts
- IRS 1099-K threshold guidance: https://www.irs.gov/businesses/understanding-your-form-1099-k
- Track1099 API: https://www.track1099.com/info/api
