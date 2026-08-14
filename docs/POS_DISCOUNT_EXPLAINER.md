# Layaway prototype: why POS now uses a discount for the deposit

## TL;DR

Shopify has no native "pay whatever amount you want toward an order" online. The only thing
an online customer can pay is the order's exact outstanding amount. That one constraint
forced every other decision. POS's original flow was cleaner, but it produced orders that
online customers could only pay off in full — never in installments. To make installments
work everywhere, all layaway orders now start small (deposit only) and grow with each
payment. On the web we shrink the first checkout with a Cart Transform function. On POS the
only lever an extension has to shrink a checkout is a discount — so that's what we use.
Discounting was never the plan for online, and it still isn't. It's a POS-only workaround
for the deposit step.

---

## What was working (and why we liked it)

The original POS flow was the cleanest thing in the whole project:

1. Build a cart at full price, attach the customer
2. Tag it as a layaway (our extension writes the attributes)
3. At the register, capture a partial payment — a native POS feature
4. Result: ONE order, total $1,000, paid $250, **outstanding $750**, status "partially paid"

Zero hacks. Native badges, native "Collect payment" button, real numbers on the order.

## Where it broke

The order carries its **entire remaining balance as "outstanding."** That's fine in a store,
because a cashier can take a partial payment against an order. Online, there is exactly one
payment button — **Pay now** — and it always charges the **full outstanding amount**. There is
no field where a customer types "$200 of my $750, please."

So a customer with a POS-created layaway who wanted to pay $200 from their account page
had two options: pay all $750, or drive to the store. That killed the online installment
requirement, and we proved it live — our first customer-account payment attempt errored
against exactly this wall.

## The fix (which is actually the original architecture)

Our Option C diagram already had the answer; the POS flow just wasn't following it:

> The order starts at the **deposit amount** and **grows with every payment**.
> Each installment is an Order Edit that adds a custom line item for exactly the amount
> the customer chose. That line becomes the order's outstanding amount — so the native
> Pay now button (online) or Collect payment button (POS) charges **exactly that much**.

One order shape, one payment engine, every channel:

| Step | Order total | Outstanding | Who can pay it |
|---|---|---|---|
| Deposit $250 on $1,000 layaway | $250 (paid) | $0 | — |
| Customer requests $200 online | $450 | $200 | Pay now, email link, or POS |
| Pays it, later pays $550 in store | $1,000 | $0 | done — hold releases, ships |

The real total ($1,000) lives in the order's attributes and a metafield ledger — that ledger,
not the order total, is the source of truth for reporting. (This was always an explicit
trade-off in the design.)

## So why discounts on POS?

Because of how each channel lets us make the *first* checkout charge only the deposit:

- **Web**: a **Cart Transform function** reprices the cart lines at checkout so the customer
  pays the deposit. This is the diagram's recommended "deposit-as-product" approach.
  It is not a discount — no discount codes, no promotion, just repricing. This was always
  the plan for online, and it's what runs today.
- **POS**: Cart Transform functions don't give us that lever at the register, and we no longer
  want the native partial-payment path (it creates the incompatible full-outstanding shape).
  The only tool a POS extension has to lower the amount checkout charges is the **Cart API's
  discount**. So when the cashier creates a layaway, the extension applies a fixed-amount
  discount equal to the balance. The customer pays the deposit as a normal, full payment,
  and the order lands in the same deposit shape as a web order.

So: **discounting is POS-only, deposit-step-only.** Installments never use discounts on any
channel — they're Order Edit line items.

## What we gave up

- POS checkout is one step less "native-feeling" (a discount line reads "Layaway — balance
  due later" instead of a partial-payment receipt)
- Order totals no longer equal merchandise value mid-layaway — reporting must read the
  ledger (metafield), which the design flagged from day one
- Small tax deltas per payment (tax recalculates on each checkout — also by design)

## What we got

- **One order shape** for POS and web layaways — indistinguishable downstream
- **Any amount, any channel**: customers pay $50 or $500, online or in store, and the right
  button always charges the right amount
- One installment engine (Order Edit) shared by the customer account page, the POS
  extension, and email pay links
- Fulfillment holds release automatically at $0 balance — "ships at full payoff"

## One-line version for execs

*Online payments can only ever charge an order's exact outstanding amount, so instead of
creating layaway orders that owe everything up front, we create them small and grow them
one payment at a time — and a POS discount at the deposit step is simply how we make the
register speak that same language.*
