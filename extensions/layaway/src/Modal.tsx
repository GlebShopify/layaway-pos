import "@shopify/ui-extensions/preact";
import {render} from 'preact';
import {useState, useEffect} from 'preact/hooks';

export default async () => {
  render(<Extension />, document.body);
};

const MIN_DEPOSIT_RATE = 0.1;
// Layaway backend (fallback installment engine when POS Direct API lacks
// order-edit access). Tunnel URL — update if the tunnel restarts.
const BACKEND_URL = 'https://ebooks-statistics-janet-latex.trycloudflare.com';
const SHOP = 'se-shopvip-en-cten.myshopify.com';

const ORDERS_QUERY = `#graphql
  query LayawayOrders($search: String!) {
    orders(first: 25, query: $search, sortKey: CREATED_AT, reverse: true) {
      nodes {
        id
        legacyResourceId
        name
        createdAt
        currencyCode
        presentmentCurrencyCode
        displayFinancialStatus
        customer {
          displayName
          email
        }
        customAttributes {
          key
          value
        }
        totalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        totalOutstandingSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        metafield(namespace: "$app:layaway", key: "ledger") {
          value
        }
      }
    }
  }
`;

function buildSearchQuery(term: string) {
  // Match POS/legacy partially_paid layaways AND backend-tagged layaways.
  const base = '(financial_status:partially_paid OR tag:layaway)';
  const t = term.trim();
  if (!t) return base;
  if (t.includes('@')) return `${base} AND email:${t}`;
  if (t.startsWith('#')) return `${base} AND name:${t.slice(1)}`;
  if (/^\d+$/.test(t)) return `${base} AND name:${t}`;
  return `${base} AND ${t}`;
}

async function gqlAdmin(query: string, variables: any = {}) {
  const response = await fetch('shopify:admin/api/graphql.json', {
    method: 'POST',
    body: JSON.stringify({query, variables}),
  });
  const result = await response.json();
  if (result.errors?.length) throw new Error(result.errors[0].message);
  return result.data;
}

function orderAttr(order: any, key: string) {
  return order?.customAttributes?.find((a: any) => a.key === key)?.value;
}

/** Ledger view of an order (mirrors web/layaway.js computeLedger). */
function orderLedger(order: any) {
  const metafieldLedger = order?.metafield?.value
    ? JSON.parse(order.metafield.value)
    : null;
  const outstanding = parseFloat(
    order?.totalOutstandingSet?.shopMoney?.amount ?? '0',
  );
  const orderTotal = parseFloat(order?.totalPriceSet?.shopMoney?.amount ?? '0');
  const realTotal = parseFloat(
    metafieldLedger?.real_total ?? orderAttr(order, 'layaway_total') ?? orderTotal,
  );
  const paid = Math.max(orderTotal - outstanding, 0);
  const balance = Math.max(realTotal - paid, 0);
  return {realTotal, paid, balance, outstanding};
}

function formatMoney(moneySet: any) {
  const money = moneySet?.shopMoney;
  if (!money) return '—';
  return `$${Number(money.amount).toFixed(2)} ${money.currencyCode}`;
}

function parseMoney(value: string | undefined) {
  if (!value) return 0;
  const cleaned = String(value).replace(/[^0-9.]/g, '');
  const parsed = parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

function fmt(amount: number) {
  return `$${amount.toFixed(2)}`;
}

function Extension() {
  const [view, setView] = useState('home');

  // --- Pay existing layaway state ---
  const [searchTerm, setSearchTerm] = useState('');
  const [orders, setOrders] = useState<any[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // --- Collect (installment) state ---
  const [collectOrder, setCollectOrder] = useState<any>(null);
  const [collectAmount, setCollectAmount] = useState('');
  const [collecting, setCollecting] = useState(false);
  const [collectError, setCollectError] = useState<string | null>(null);

  // --- New layaway state ---
  const [cart, setCart] = useState<any>(shopify.cart.current.value);
  const [depositInput, setDepositInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [layawayCreated, setLayawayCreated] = useState(false);

  useEffect(() => {
    const unsubscribe = shopify.cart.current.subscribe((newCart: any) => {
      setCart(newCart);
    });
    return unsubscribe;
  }, []);

  async function searchOrders(term: string) {
    setLoading(true);
    setError(null);
    try {
      const data = await gqlAdmin(ORDERS_QUERY, {search: buildSearchQuery(term)});
      setOrders(data.orders.nodes);
      setHasSearched(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to search orders');
      setOrders([]);
    } finally {
      setLoading(false);
    }
  }

  function navigateToOrder(order: any) {
    navigation
      .navigate(`shopify:point-of-sale/orders/${order.legacyResourceId}`)
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : 'Failed to open order');
      });
  }

  /**
   * Unified pay flow (Option C):
   * - Order already has an amount due (legacy POS shape or a pending
   *   installment): open it — native Collect payment takes it from here.
   * - Deposit-shape order (no outstanding): ask how much, add a
   *   "Layaway payment" via Order Edit, then open it for tap-to-pay.
   */
  function selectOrder(order: any) {
    if (!order?.legacyResourceId) {
      setError('Missing order ID — cannot open order');
      return;
    }
    setCollectOrder(order);
    setCollectAmount('');
    setCollectError(null);
    setView('collect');
  }

  /** Cancel the pending installment (backend engine) and refresh the order. */
  async function cancelPendingAndRefresh() {
    const order = collectOrder;
    setCollecting(true);
    setCollectError(null);
    try {
      const response = await fetch(
        `${BACKEND_URL}/api/layaway/${order.legacyResourceId}/payment/cancel`,
        {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({shop: SHOP}),
        },
      );
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error ?? 'Could not cancel pending payment');
      }
      // Poll until the outstanding clears, then refresh the order node.
      for (let attempt = 0; attempt < 8; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1200));
        const check = await gqlAdmin(
          `#graphql
          query Refresh($id: ID!) {
            node(id: $id) {
              ... on Order {
                id
                legacyResourceId
                name
                createdAt
                currencyCode
                presentmentCurrencyCode
                displayFinancialStatus
                customer { displayName email }
                customAttributes { key value }
                totalPriceSet { shopMoney { amount currencyCode } }
                totalOutstandingSet { shopMoney { amount currencyCode } }
                metafield(namespace: "$app:layaway", key: "ledger") { value }
              }
            }
          }`,
          {id: order.id},
        );
        const fresh = check.node;
        const outstanding = parseFloat(
          fresh?.totalOutstandingSet?.shopMoney?.amount ?? '1',
        );
        if (outstanding <= 0.01) {
          setCollectOrder(fresh);
          break;
        }
      }
    } catch (e) {
      setCollectError(
        e instanceof Error ? e.message : 'Could not cancel pending payment',
      );
    } finally {
      setCollecting(false);
    }
  }

  /** Installment via the app backend (offline token — always has scopes). */
  async function addInstallmentViaBackend(order: any, amount: number) {
    const orderId = order.legacyResourceId;
    const response = await fetch(`${BACKEND_URL}/api/layaway/${orderId}/payment`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        amount: amount.toFixed(2),
        shop: SHOP,
        channel: 'pos',
        notifyCustomer: false,
      }),
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error ?? 'Backend payment request failed');
    }
  }

  /** Installment via POS Direct API (preferred — no tunnel dependency). */
  async function addInstallmentViaDirectApi(order: any, amount: number) {
    {
      const begin = await gqlAdmin(
        `#graphql
        mutation Begin($id: ID!) {
          orderEditBegin(id: $id) {
            calculatedOrder { id }
            userErrors { message }
          }
        }`,
        {id: order.id},
      );
      if (begin.orderEditBegin.userErrors?.length) {
        throw new Error(begin.orderEditBegin.userErrors[0].message);
      }
      const calcId = begin.orderEditBegin.calculatedOrder.id;

      const add = await gqlAdmin(
        `#graphql
        mutation AddItem($id: ID!, $title: String!, $price: MoneyInput!, $quantity: Int!) {
          orderEditAddCustomItem(
            id: $id
            title: $title
            price: $price
            quantity: $quantity
            taxable: false
            requiresShipping: false
          ) {
            userErrors { message }
          }
        }`,
        {
          id: calcId,
          title: 'Layaway payment (in store)',
          price: {
            amount: amount.toFixed(2),
            currencyCode:
              order.presentmentCurrencyCode ?? order.currencyCode ?? 'USD',
          },
          quantity: 1,
        },
      );
      if (add.orderEditAddCustomItem.userErrors?.length) {
        throw new Error(add.orderEditAddCustomItem.userErrors[0].message);
      }

      const commit = await gqlAdmin(
        `#graphql
        mutation Commit($id: ID!) {
          orderEditCommit(id: $id, notifyCustomer: false, staffNote: "Layaway installment collected at POS") {
            order { id }
            userErrors { message }
          }
        }`,
        {id: calcId},
      );
      if (commit.orderEditCommit.userErrors?.length) {
        throw new Error(commit.orderEditCommit.userErrors[0].message);
      }
    }
  }

  async function addInstallmentAndOpen() {
    const order = collectOrder;
    const ledger = orderLedger(order);
    const amount = parseMoney(collectAmount);
    if (!(amount > 0) || amount > ledger.balance + 0.005) return;

    setCollecting(true);
    setCollectError(null);
    try {
      try {
        await addInstallmentViaDirectApi(order, amount);
      } catch (directError) {
        // Direct API denied (e.g. POS session lacks order-edit grant) —
        // fall back to the app backend's installment engine.
        await addInstallmentViaBackend(order, amount);
      }

      // Poll until the outstanding amount lands (no read-after-write guarantee).
      for (let attempt = 0; attempt < 8; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1200));
        const check = await gqlAdmin(
          `#graphql
          query Check($id: ID!) {
            order(id: $id) {
              totalOutstandingSet { shopMoney { amount } }
            }
          }`,
          {id: order.id},
        );
        const outstanding = parseFloat(
          check.order?.totalOutstandingSet?.shopMoney?.amount ?? '0',
        );
        if (outstanding >= amount - 0.01) break;
      }

      navigateToOrder(order);
    } catch (e) {
      setCollectError(
        e instanceof Error ? e.message : 'Failed to prepare payment',
      );
    } finally {
      setCollecting(false);
    }
  }

  // --- New layaway derived values ---
  const lineItems = cart?.lineItems ?? [];
  const hasItems = lineItems.length > 0;
  const hasCustomer = Boolean(cart?.customer?.id);
  const cartTotal = parseMoney(cart?.grandTotal);
  const minDeposit = cartTotal * MIN_DEPOSIT_RATE;
  const deposit = parseMoney(depositInput);
  const depositPct = cartTotal > 0 ? (deposit / cartTotal) * 100 : 0;
  const balance = Math.max(cartTotal - deposit, 0);
  const depositTooLow = depositInput !== '' && deposit < minDeposit;
  const depositTooHigh = deposit > cartTotal;
  const depositValid =
    depositInput !== '' && !depositTooLow && !depositTooHigh && deposit > 0;
  const canCreate = hasItems && hasCustomer && depositValid && !saving;

  const depositError = depositTooLow
    ? `Minimum deposit is 10% of cart total (with tax): ${fmt(minDeposit)}`
    : depositTooHigh
      ? `Deposit cannot exceed cart total ${fmt(cartTotal)}`
      : undefined;

  function setDepositPercent(pct: number) {
    setDepositInput(((cartTotal * pct) / 100).toFixed(2));
  }

  async function createLayaway() {
    setSaving(true);
    setSaveError(null);
    try {
      const createdAt = new Date().toISOString();
      const layawayProps: Record<string, string> = {
        layaway: 'true',
        layaway_status: 'deposit_pending',
        layaway_total: cartTotal.toFixed(2),
        layaway_deposit: deposit.toFixed(2),
        layaway_deposit_pct: depositPct.toFixed(1),
        layaway_balance: balance.toFixed(2),
        layaway_created_at: createdAt,
        layaway_channel: 'pos',
      };
      await shopify.cart.addCartProperties(layawayProps);
      await shopify.cart.bulkAddLineItemProperties(
        lineItems.map((li: any) => ({
          lineItemUuid: li.uuid,
          properties: {
            layaway: 'true',
            layaway_deposit: deposit.toFixed(2),
            layaway_balance: balance.toFixed(2),
          },
        })),
      );
      // Option C unification: discount the cart down to the deposit so
      // checkout charges EXACTLY the deposit as a normal full payment.
      // The order lands deposit-shaped — identical to web reserves.
      await shopify.cart.applyCartDiscount(
        'FixedAmount',
        'Layaway — balance due later',
        balance.toFixed(2),
      );
      setLayawayCreated(true);
    } catch (e) {
      setSaveError(
        e instanceof Error ? e.message : 'Failed to tag cart as layaway',
      );
    } finally {
      setSaving(false);
    }
  }

  if (view === 'home') {
    return (
      <s-page heading="Layaway">
        <s-scroll-box>
          <s-box padding="base">
            <s-stack direction="block" gap="base">
              <s-section heading="What would you like to do?">
                <s-stack direction="block" gap="base">
                  <s-button
                    variant="primary"
                    onClick={() => {
                      setLayawayCreated(false);
                      setSaveError(null);
                      setDepositInput('');
                      setView('new');
                    }}
                  >
                    New layaway order
                  </s-button>
                  <s-button
                    onClick={() => {
                      setView('pay');
                      searchOrders('');
                    }}
                  >
                    Pay existing layaway
                  </s-button>
                </s-stack>
              </s-section>
            </s-stack>
          </s-box>
        </s-scroll-box>
      </s-page>
    );
  }

  if (view === 'collect') {
    const ledger = orderLedger(collectOrder);
    const amount = parseMoney(collectAmount);
    const amountValid = amount > 0 && amount <= ledger.balance + 0.005;
    const amountError =
      collectAmount !== '' && !amountValid
        ? `Enter an amount between $0.01 and ${fmt(ledger.balance)}`
        : undefined;

    if (ledger.outstanding > 0.01) {
      return (
        <s-page heading={`Collect payment — ${collectOrder?.name ?? ''}`}>
          <s-scroll-box>
            <s-box padding="base">
              <s-stack direction="block" gap="base">
                <s-button onClick={() => setView('pay')}>Back</s-button>

                <s-section heading="Layaway balance">
                  <s-stack direction="block" gap="small-200">
                    <s-text>{`Total: ${fmt(ledger.realTotal)}`}</s-text>
                    <s-text>{`Paid so far: ${fmt(ledger.paid)}`}</s-text>
                    <s-text>{`Remaining balance: ${fmt(ledger.balance)}`}</s-text>
                  </s-stack>
                </s-section>

                <s-banner heading={`${fmt(ledger.outstanding)} ready to collect`}>
                  A payment of {fmt(ledger.outstanding)} has already been
                  requested on this order and is awaiting collection.
                </s-banner>

                {collectError && (
                  <s-banner tone="critical" heading="Could not update payment">
                    <s-text>{collectError}</s-text>
                  </s-banner>
                )}

                <s-button
                  variant="primary"
                  disabled={collecting}
                  onClick={() => navigateToOrder(collectOrder)}
                >
                  {`Open order & collect ${fmt(ledger.outstanding)}`}
                </s-button>
                <s-button
                  disabled={collecting}
                  loading={collecting}
                  onClick={() => cancelPendingAndRefresh()}
                >
                  Choose a different amount
                </s-button>
              </s-stack>
            </s-box>
          </s-scroll-box>
        </s-page>
      );
    }

    return (
      <s-page heading={`Collect payment — ${collectOrder?.name ?? ''}`}>
        <s-scroll-box>
          <s-box padding="base">
            <s-stack direction="block" gap="base">
              <s-button onClick={() => setView('pay')}>Back</s-button>

              <s-section heading="Layaway balance">
                <s-stack direction="block" gap="small-200">
                  <s-text>{`Total: ${fmt(ledger.realTotal)}`}</s-text>
                  <s-text>{`Paid so far: ${fmt(ledger.paid)}`}</s-text>
                  <s-text>{`Remaining balance: ${fmt(ledger.balance)}`}</s-text>
                </s-stack>
              </s-section>

              <s-section heading="How much is the customer paying today?">
                <s-stack direction="block" gap="base">
                  <s-stack direction="inline" gap="small-200">
                    <s-button
                      onClick={() =>
                        setCollectAmount((ledger.balance * 0.25).toFixed(2))
                      }
                    >
                      25%
                    </s-button>
                    <s-button
                      onClick={() =>
                        setCollectAmount((ledger.balance * 0.5).toFixed(2))
                      }
                    >
                      50%
                    </s-button>
                    <s-button
                      onClick={() => setCollectAmount(ledger.balance.toFixed(2))}
                    >
                      Pay in full
                    </s-button>
                  </s-stack>
                  <s-number-field
                    label="Payment amount"
                    value={collectAmount}
                    error={amountError}
                    onInput={(event) =>
                      setCollectAmount(event.currentTarget.value ?? '')
                    }
                  />
                </s-stack>
              </s-section>

              {collectError && (
                <s-banner tone="critical" heading="Could not prepare payment">
                  <s-text>{collectError}</s-text>
                </s-banner>
              )}

              <s-button
                variant="primary"
                disabled={!amountValid || collecting}
                loading={collecting}
                onClick={() => addInstallmentAndOpen()}
              >
                {amountValid
                  ? `Prepare ${fmt(amount)} & open order`
                  : 'Prepare payment & open order'}
              </s-button>
              <s-text>
                This adds the payment to the order, then opens it — use
                Collect payment to take the exact amount by card, cash, or
                tap-to-pay.
              </s-text>
            </s-stack>
          </s-box>
        </s-scroll-box>
      </s-page>
    );
  }

  if (view === 'new') {
    if (layawayCreated) {
      return (
        <s-page heading="New layaway">
          <s-scroll-box>
            <s-box padding="base">
              <s-stack direction="block" gap="base">
                <s-banner tone="success" heading="Layaway created">
                  This cart is now a layaway. The balance was discounted off
                  the cart, so checkout will charge exactly the deposit.
                </s-banner>
                <s-section heading="Deposit summary">
                  <s-stack direction="block" gap="small-200">
                    <s-text>{`Full total (with tax): ${fmt(cartTotal)}`}</s-text>
                    <s-text>{`Deposit due now (${depositPct.toFixed(1)}%): ${fmt(deposit)}`}</s-text>
                    <s-text>{`Remaining balance: ${fmt(balance)}`}</s-text>
                  </s-stack>
                </s-section>
                <s-banner heading="Next step: collect the deposit">
                  Proceed to checkout and complete payment in full — the total
                  IS the deposit. No partial payment needed.
                </s-banner>
                <s-button variant="primary" onClick={() => window.close()}>
                  Close and go to checkout
                </s-button>
              </s-stack>
            </s-box>
          </s-scroll-box>
        </s-page>
      );
    }

    return (
      <s-page heading="New layaway">
        <s-scroll-box>
          <s-box padding="base">
            <s-stack direction="block" gap="base">
              <s-button onClick={() => setView('home')}>Back</s-button>

              {!hasItems && (
                <s-banner tone="warning" heading="Cart is empty">
                  Add products to the cart before starting a layaway.
                </s-banner>
              )}

              {hasItems && !hasCustomer && (
                <s-banner tone="warning" heading="No customer on cart">
                  Add a customer to the cart — layaway orders need a customer
                  to collect the balance later.
                </s-banner>
              )}

              <s-section heading="Cart summary">
                <s-stack direction="block" gap="small-200">
                  <s-text>{`Items: ${lineItems.length}`}</s-text>
                  <s-text>{`Subtotal: ${cart?.subtotal ?? '—'}`}</s-text>
                  <s-text>{`Tax: ${cart?.taxTotal ?? '—'}`}</s-text>
                  <s-text>{`Total (with tax): ${cart?.grandTotal ?? '—'}`}</s-text>
                </s-stack>
              </s-section>

              <s-section heading="Deposit">
                <s-stack direction="block" gap="base">
                  <s-stack direction="inline" gap="small-200">
                    <s-button onClick={() => setDepositPercent(10)}>10%</s-button>
                    <s-button onClick={() => setDepositPercent(25)}>25%</s-button>
                    <s-button onClick={() => setDepositPercent(50)}>50%</s-button>
                  </s-stack>
                  <s-number-field
                    label="Deposit amount"
                    details={`Minimum 10% of ${fmt(cartTotal)} = ${fmt(minDeposit)}`}
                    value={depositInput}
                    error={depositError}
                    onInput={(event) =>
                      setDepositInput(event.currentTarget.value ?? '')
                    }
                  />
                  {depositValid && (
                    <s-stack direction="block" gap="small-200">
                      <s-text>{`Deposit due now (${depositPct.toFixed(1)}%): ${fmt(deposit)}`}</s-text>
                      <s-text>{`Remaining balance: ${fmt(balance)}`}</s-text>
                    </s-stack>
                  )}
                </s-stack>
              </s-section>

              {saveError && (
                <s-banner tone="critical" heading="Could not create layaway">
                  {saveError}
                </s-banner>
              )}

              <s-button
                variant="primary"
                disabled={!canCreate}
                loading={saving}
                onClick={() => createLayaway()}
              >
                Create layaway
              </s-button>
            </s-stack>
          </s-box>
        </s-scroll-box>
      </s-page>
    );
  }

  return (
    <s-page heading="Pay existing layaway">
      <s-scroll-box>
        <s-box padding="base">
          <s-stack direction="block" gap="base">
            <s-button onClick={() => setView('home')}>Back</s-button>
            <s-search-field
              placeholder="Customer email or order #"
              value={searchTerm}
              onInput={(event) => setSearchTerm(event.currentTarget.value ?? '')}
              onChange={(event) => {
                const value = event.currentTarget.value ?? '';
                setSearchTerm(value);
                searchOrders(value);
              }}
            />
            <s-button variant="primary" loading={loading} onClick={() => searchOrders(searchTerm)}>
              Search layaway orders
            </s-button>

            {error && (
              <s-banner tone="critical" heading="Search failed">
                {error}
              </s-banner>
            )}

            {loading && <s-text>Searching layaway orders…</s-text>}

            {!loading && hasSearched && orders.length === 0 && (
              <s-banner heading="No layaway orders found">
                No layaway orders match this search. Try a different customer
                email or order number.
              </s-banner>
            )}

            {!loading && orders.length > 0 && (
              <s-section heading={`Open layaways (${orders.length})`}>
                <s-stack direction="block" gap="base">
                  {orders.map((order) => {
                    const ledger = orderLedger(order);
                    return (
                      <s-clickable key={order.id} onClick={() => selectOrder(order)}>
                        <s-box padding="base">
                          <s-stack direction="block" gap="small-200">
                            <s-stack direction="inline" gap="small-200">
                              <s-heading>{order.name}</s-heading>
                              <s-badge
                                tone={ledger.balance <= 0.005 ? 'success' : 'warning'}
                              >
                                {ledger.balance <= 0.005
                                  ? 'Paid in full'
                                  : 'Layaway'}
                              </s-badge>
                            </s-stack>
                            <s-text>
                              {order.customer
                                ? `${order.customer.displayName} · ${order.customer.email ?? ''}`
                                : 'No customer'}
                            </s-text>
                            <s-text>
                              {`Balance: ${fmt(ledger.balance)} of ${fmt(ledger.realTotal)} (paid ${fmt(ledger.paid)})`}
                            </s-text>
                            <s-text>Tap to collect a payment</s-text>
                          </s-stack>
                        </s-box>
                      </s-clickable>
                    );
                  })}
                </s-stack>
              </s-section>
            )}
          </s-stack>
        </s-box>
      </s-scroll-box>
    </s-page>
  );
}
