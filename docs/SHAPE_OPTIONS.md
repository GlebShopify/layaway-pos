# Layaway order shapes: why POS and web differed, and the options

## Q1: Does ecomm have to use discounts because POS does?
No. Channels share a TARGET SHAPE, not a mechanism. Rule: every layaway order must end
deposit-shaped (order total = money charged so far; real total in the ledger).
- Web: Cart Transform function (repricing — not a discount)
- POS: Cart API fixed discount (only price lever a POS extension has)
Web could use a discount function; repricing is cleaner (no stacking/promo analytics pollution).

## Q2: Why was the split-tender POS order a different shape?
"Outstanding" is a single, indivisible amount due on an order.
- POS native partial payment: total $1,000, paid $250, OUTSTANDING $750
- Web deposit order: total $250, paid $250, OUTSTANDING $0 (ledger tracks $750)
Online, the only customer payment is Pay now = the ENTIRE outstanding. No partial field,
no API for "checkout for part of the outstanding." POS-shape = all-or-nothing online.
Deposit-shape flips it: outstanding is created per-installment (Order Edit line = $X),
so Pay now charges exactly $X.

## Q3: Same shape while keeping native split tender?
Post-hoc reshape (Option C below) is possible but risky: tax charged on full total at the
register, then the total is reduced afterward → adjustments, refund weirdness, race window.
The clean answer is a platform primitive (Option D).

## Q4: Cashier UX
The discount model is a BETTER cashier experience: normal checkout, on-screen total IS the
deposit. No remembering amounts, no partial-tender steps, fewer errors.

## Options — cost/benefit

### A. Native POS partial payment (original)
+ Cleanest POS data (true totals, real partially_paid, native receipts)
+ Zero extension logic at tender
- Online installments impossible (full outstanding is all-or-nothing)
- Cashier manually enters partial amount (error-prone)
- Two shapes forever
Verdict: great single-channel story; fails the requirement.

### B. Discount/reprice at creation (SHIPPED)
+ One shape everywhere; any amount, any channel
+ Simplest cashier flow (normal checkout)
+ Installments are plain Order Edit lines; tax computed per payment
- Order totals != merchandise value → reporting must read the ledger
- Discount line visible on order/receipts; no native "Partially paid" badge (status in ledger)
Verdict: best available today; costs are cosmetic/reporting, benefits functional.

### C. Native split tender + post-hoc reshape via webhook
+ Native POS tender UX, ends in unified shape
- Tax charged on full total, then total reduced afterward (adjustments/credits)
- Race window with wrong-shape order; refunds hairy; most moving parts
Verdict: possible, not worth the risk; back-pocket option.

### D. Platform primitive: add a transaction of $X to an existing order (THE ASK)
+ Native everything; deletes most workaround code (cart transform, discounts, ledger gymnastics)
- Doesn't exist yet
Verdict: the end-state. The prototype is the interim solution AND the evidence for the ask
(diagram note: "Ask to POS: allow adding a transaction to an existing order").

## Recommendation
Ship/demo B now. Keep D as the formal product ask. Hold C in reserve if cashier-experience
feedback demands native tender.
