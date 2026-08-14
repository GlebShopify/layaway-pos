# Layaway / Reserves — Web Experience Design (Option C: Order Edit as the Installment Engine)

Companion to the existing POS UI extension. One app (`layaway-pos`), one order per layaway,
one shared ledger schema across POS and web.

---

## 1. Principles (from FN_Reserves_Arch_OptionC)

- **ONE order** per layaway · N transactions. No 2nd "reserve store", no middleware bridge, no selling-plan app.
- **Order Edit API is the installment/invoice vehicle** — a custom line item = customer-set payment amount → instantly generates a real checkout.
- **Ledger is the source of truth** (order note attributes + app metafield), *not* the order total. Reporting reads the ledger.
- **Functions run on each checkout** — tax recalculated per payment.
- **Ships at full payoff** — fulfillment hold until ledger balance = 0.
- **POS parity** — same attribute schema, same modal math (10% minimum incl. tax), same order shape.

## 2. Shared data model (already shipped in POS v4 — do not change keys)

Order **note attributes** (from cart attributes) + line item properties:

| Key | Example | Notes |
|---|---|---|
| `layaway` | `true` | discriminator for search/reporting |
| `layaway_status` | `deposit_pending` → `active` → `completed` | app-managed lifecycle |
| `layaway_total` | `1650.00` | REAL total (with tax) — the ledger anchor |
| `layaway_deposit` | `165.00` | deposit amount |
| `layaway_deposit_pct` | `10.0` | |
| `layaway_balance` | `1485.00` | decremented per payment |
| `layaway_created_at` | ISO 8601 | |
| `layaway_channel` | `pos` \| `web` | NEW — set by each surface |

Backend mirror: metafield `$app:layaway.ledger` (JSON) on the Order — authoritative ledger:
`{ real_total, paid, balance, payments: [{n, amount, at, channel, txn_id}], status }`.
Note attributes are the human-visible copy; the metafield is what code trusts.

## 3. Surfaces & components

| # | Surface | Component | Job |
|---|---|---|---|
| 1 | Cart (online store) | **Theme app extension** (app embed) | "Pay With Reserve" link under eligible items → **Enter Down Payment modal** |
| 2 | Cart → Checkout | **Cart Transform Function** | Deposit-as-product: reprice checkout to charge only the deposit |
| 3 | Checkout | **Checkout UI extension** | Breakdown block: Reserve total / Due today / Remaining balance (reads cart attributes) |
| 4 | Backend | **Remix app server** (add to `layaway-pos`) | Webhooks, Order Edit installment engine, ledger, fulfillment hold |
| 5 | Customer accounts | **Customer Account UI extension** | Installment plan card on order status/index + **Make a payment modal** → pay link |
| 6 | POS | **Existing POS UI extension** | Same modal math; interop hooks (section 6) |

## 4. Flow A — Deposit (web)

```
Cart drawer                     Modal (theme ext)                Checkout                    Order
"Pay With Reserve" ──────────▶ enter deposit ≥ 10%  ──────────▶ charges DEPOSIT only ─────▶ ONE order created
                               shows: Reserve Total,            (Cart Transform:            note attrs = layaway_*
                               Tax/Shipping @ checkout,          deposit-as-product;        │
                               Due Today, Remaining,             Checkout UI ext shows      ▼ webhook orders/create
                               terms checkbox                    breakdown)                 app: ledger metafield,
                                                                                            fulfillment HOLD,
                                                                                            Order Edit #0: add custom line
                                                                                            "Layaway balance" = remaining
                                                                                            → order total = REAL total
                                                                                            → financial_status = partially_paid
```

1. **Theme app extension** injects "Reserve it for $X · Pay With Reserve" in cart (eligibility: product tag/metafield `reserve_eligible`, min price, etc.).
2. Modal (matches FASHIONPHILE screenshot): amount field prefilled at 10%, error `10% minimum down payment required` if below (same math as POS: min = 10% of total incl. tax; tax/shipping "Calculated on Checkout" line when unknown), Due Today, Remaining balance + due date, restocking-fee notice, terms checkbox.
3. On Checkout click: write **cart attributes** (`layaway_*`, `layaway_channel=web`) + line item properties (`layaway=true`, deposit/balance) via AJAX Cart API → redirect `/checkout`.
4. **Cart Transform Function**: sees `layaway=true` cart attribute → converts the cart to charge only the deposit (deposit-as-product, recommended by diagram; no discounting). Implementation options, in preference order:
   a. `update` operation repricing the line to the deposit (validate API version supports price override), or
   b. swap in an app-owned "Reserve Deposit" variant expanded with custom price, keeping original items as $0-priced components (title keeps product name), or
   c. fallback: automatic discount Function reducing payable to deposit (diagram flags this "messy" — last resort).
5. **Checkout UI extension** (purchase.checkout.block.render): reads cart attributes → "Layaway breakdown: Reserve total $1,650 · Due today $165 · Remaining $1,485 (due by DATE)". Also render on Thank-you page target.
6. **Webhook `orders/create`** (app backend): if `layaway=true`:
   - Write ledger metafield.
   - Apply **fulfillment hold** (`fulfillmentOrderHold`) — "Ships at full payoff".
   - **Order Edit #0**: add custom line item `Layaway balance — remaining` = `layaway_balance`, *not* invoiced → order total = real total, paid = deposit → **`partially_paid`**. ← this is what makes web orders identical to POS-created ones and visible to the POS "Pay existing layaway" search.

## 5. Flow B — Installments (customer accounts)

```
My Account (Customer Account ext)     App backend                         Checkout (installment)
Installment plan card                 POST /layaway/:orderId/payment      customer pays $X
 remaining / paid so far / history ─▶ {amount ≥ min}                 ┌──▶ Function recalcs tax
 [Make a payment] modal               validate vs ledger              │    posts transaction ×N
        │                             Order Edit: custom line item    │         │
        └── same 10%-min UX           "Layaway payment #n" = $X ──────┘         ▼ webhook
                                      commit → returns pay-now URL         orders/edited + transactions
                                      (order outstanding = $X)             ledger: paid += X, balance -= X
                                                                           balance = 0 → status=completed,
                                                                           RELEASE hold → ships
```

- **Customer Account UI extension** (order status block, matches screenshot): "Installment plan" card — Remaining balance, Paid so far `$paid of $real_total`, Payment history, info banner for pending installment, **Pay now**.
- "Make a payment" modal = same component/math as POS + web deposit modal (amount, min validation, live remaining math).
- Extension can't call Admin API directly → calls **app backend** with session-token auth. Backend:
  1. Validates amount against ledger (min payment, ≤ balance).
  2. `orderEditBegin` → `orderEditAddCustomItem` ("Layaway payment #n", amount) → `orderEditCommit` (notify customer = true sends native invoice email with amount owing).
  3. **Poll after commit** (no read-after-write guarantee — diagram landmine) until edit lands, then return the order's pay-outstanding URL → extension opens it.
  4. On payment webhook: append to ledger `payments[]`, decrement balance. Balance 0 → `layaway_status=completed`, release fulfillment hold.

Note on order total drift: with Order Edit #0 (section 4.6), order total already equals real total, so installment custom line items would inflate it. Mitigation: each installment edit **pairs** the added payment line with an equal decrement of the "Layaway balance — remaining" placeholder line (reduce its price/remove and re-add at new balance) — total stays = real total, outstanding = current installment. This keeps `partially_paid` semantics correct all the way to payoff. (If the placeholder-reprice path is fought by the API, fallback: skip Order Edit #0 and accept ledger-only totals — diagram's stance — and relax the POS search to attributes, section 6.)

## 6. POS interop (must-haves)

| Concern | Design |
|---|---|
| POS deposit flow (shipped) | Unchanged: cart props + line props, cashier captures deposit at drawer → true `partially_paid`. Add `layaway_channel=pos`. |
| POS "Pay existing layaway" search | Today: `financial_status:partially_paid`. Extend query to also match ledger orders: `financial_status:partially_paid OR (tag:layaway)` — backend tags every layaway order `layaway` on creation for cheap search. |
| Collect web-layaway balance in store | Order opened natively on POS shows outstanding (thanks to Order Edit #0 / paired edits) → native **Collect payment** tap-to-pay. For custom partial amount in store: POS modal asks amount → calls same backend `POST /layaway/:id/payment` → refresh order → outstanding = amount → Collect payment. One engine, two channels. |
| Pay POS-layaway from home | POS-created orders carry the same attributes → customer account card renders identically; Make a payment uses the same endpoint. |
| Ledger consistency | Only the backend mutates the ledger (webhooks cover POS-collected payments too, via `order_transactions/create`). Surfaces only read. |

## 7. Landmines (from diagram) & mitigations

- `read_all_orders` scope — layaways live > 60 days. Request scope; justify in app review notes.
- Poll after `orderEditCommit` — no read-after-write guarantee.
- **Reporting/exports must read the ledger**, not order totals.
- Payment reversal is powerful — gate who can void/adjust (staff permission check in POS ext; backend authz).
- Cart Transform price override support must be verified on current API version before committing to option 4.4a.
- Customer account "Pay now" URL: use the order transaction/invoice URL from the committed edit; do not hand-construct.

## 8. Build plan

| Phase | Scope | Proof point |
|---|---|---|
| **P1** | App backend (Remix) + webhooks + ledger metafield + `layaway` tag + fulfillment hold; POS search extended to tag | POS + backend speak the same ledger |
| **P2** | Theme app extension: cart link + Enter Down Payment modal → cart attributes; Checkout UI extension breakdown; checkout charges full amount (no transform yet) — demo of data flow | Attributes land on order; breakdown renders |
| **P3** | Cart Transform deposit-as-product + Order Edit #0 on webhook → web deposit produces `partially_paid` order | Web deposit order identical to POS order |
| **P4** | Customer Account UI extension: installment card + Make a payment modal + backend installment engine (Order Edit ×N) | Full payoff releases hold; history matches screenshot |
| **P5** | POS modal "custom amount" wired to the same installment endpoint | One engine, both channels |

## 9. Repo layout (same app)

```
layaway-pos/
  app/                          ← NEW Remix backend (webhooks, /layaway/:id/payment, ledger)
  extensions/
    layaway/                    ← existing POS UI extension (tile + modal)
    layaway-theme/              ← theme app extension (cart link + down-payment modal)
    layaway-checkout/           ← checkout UI extension (breakdown block + thank-you)
    layaway-account/            ← customer account UI extension (installment card + pay modal)
    layaway-cart-transform/     ← cart transform function (deposit-as-product)
  docs/WEB_DESIGN.md            ← this file
```

Scopes to add: `write_orders` (order edit), `read_all_orders`, `write_order_edits` (if split), `write_fulfillments`/holds, `write_products` (deposit product), existing `read_orders,read_customers`.
