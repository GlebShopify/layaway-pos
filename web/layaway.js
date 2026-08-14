/**
 * Layaway ledger engine — the ONLY place that mutates layaway state.
 *
 * Ledger shape (order metafield $app:layaway / ledger, type json):
 * {
 *   real_total: "1650.00",
 *   paid: "165.00",
 *   balance: "1485.00",
 *   status: "active" | "completed",
 *   channel: "pos" | "web",
 *   created_at: ISO8601,
 *   payments: [{ n, amount, at, txn_id, channel }]
 * }
 *
 * Design rule: ledger values are RECOMPUTED from the order's outstanding
 * amount on every webhook (never incremented blindly) so POS + web payments
 * can never double-count.
 */

const LAYAWAY_TAG = "layaway";
const LEDGER_NAMESPACE = "$app:layaway";
const LEDGER_KEY = "ledger";

// ---------- GraphQL helpers ----------

async function gql(client, query, variables = {}) {
  const response = await client.request(query, { variables });
  if (response.errors) {
    throw new Error(JSON.stringify(response.errors));
  }
  return response.data;
}

const ORDER_QUERY = `#graphql
  query LayawayOrder($id: ID!) {
    order(id: $id) {
      id
      name
      currencyCode
      presentmentCurrencyCode
      tags
      displayFinancialStatus
      customAttributes { key value }
      totalPriceSet { shopMoney { amount } }
      totalOutstandingSet { shopMoney { amount } }
      transactions(first: 50) {
        id
        kind
        status
        createdAt
        amountSet { shopMoney { amount } }
      }
      metafield(namespace: "${LEDGER_NAMESPACE}", key: "${LEDGER_KEY}") {
        id
        value
      }
      fulfillmentOrders(first: 10) {
        nodes {
          id
          status
          fulfillmentHolds { reason }
        }
      }
    }
  }
`;

export async function fetchOrder(client, orderId) {
  const id = orderId.toString().startsWith("gid://")
    ? orderId
    : `gid://shopify/Order/${orderId}`;
  const data = await gql(client, ORDER_QUERY, { id });
  return data.order;
}

export function getAttr(order, key) {
  return order?.customAttributes?.find((a) => a.key === key)?.value;
}

export function isLayawayOrder(order) {
  return getAttr(order, "layaway") === "true" || order?.tags?.includes(LAYAWAY_TAG);
}

// ---------- Ledger computation ----------

export function computeLedger(order, existingLedger) {
  const outstanding = parseFloat(
    order.totalOutstandingSet?.shopMoney?.amount ?? "0",
  );
  const orderTotal = parseFloat(order.totalPriceSet?.shopMoney?.amount ?? "0");
  // Real total: prefer the attribute written by the POS/web modal; fall back
  // to the order total.
  const realTotal = parseFloat(getAttr(order, "layaway_total") ?? orderTotal);
  // Shape-agnostic math (works for POS full-total orders AND web
  // deposit-only orders that grow via Order Edit installments):
  //   paid    = what has actually been captured on the order
  //   balance = the REAL total minus what's been paid (ledger truth)
  const paid = Math.max(orderTotal - outstanding, 0);
  const balance = Math.max(realTotal - paid, 0);

  const successfulPayments = (order.transactions ?? [])
    .filter(
      (t) =>
        t.status === "SUCCESS" && (t.kind === "SALE" || t.kind === "CAPTURE"),
    )
    .map((t, i) => ({
      n: i + 1,
      amount: parseFloat(t.amountSet?.shopMoney?.amount ?? "0").toFixed(2),
      at: t.createdAt,
      txn_id: t.id,
    }));

  return {
    real_total: realTotal.toFixed(2),
    paid: paid.toFixed(2),
    balance: balance.toFixed(2),
    pending_due: Math.max(outstanding, 0).toFixed(2),
    status: balance <= 0.005 ? "completed" : "active",
    channel:
      getAttr(order, "layaway_channel") ?? existingLedger?.channel ?? "unknown",
    created_at:
      getAttr(order, "layaway_created_at") ??
      existingLedger?.created_at ??
      new Date().toISOString(),
    payments: successfulPayments,
  };
}

// ---------- Mutations ----------

export async function writeLedger(client, orderGid, ledger) {
  const mutation = `#graphql
    mutation SetLedger($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id }
        userErrors { field message }
      }
    }
  `;
  const data = await gql(client, mutation, {
    metafields: [
      {
        ownerId: orderGid,
        namespace: LEDGER_NAMESPACE,
        key: LEDGER_KEY,
        type: "json",
        value: JSON.stringify(ledger),
      },
    ],
  });
  const errors = data.metafieldsSet.userErrors;
  if (errors?.length) throw new Error(JSON.stringify(errors));
}

export async function tagOrder(client, orderGid) {
  const mutation = `#graphql
    mutation TagLayaway($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) {
        userErrors { field message }
      }
    }
  `;
  const data = await gql(client, mutation, { id: orderGid, tags: [LAYAWAY_TAG] });
  const errors = data.tagsAdd.userErrors;
  if (errors?.length) throw new Error(JSON.stringify(errors));
}

export async function holdFulfillment(client, order) {
  const mutation = `#graphql
    mutation HoldLayaway($fulfillmentHold: FulfillmentOrderHoldInput!, $id: ID!) {
      fulfillmentOrderHold(fulfillmentHold: $fulfillmentHold, id: $id) {
        userErrors { field message }
      }
    }
  `;
  const openOrders = (order.fulfillmentOrders?.nodes ?? []).filter(
    (fo) =>
      (fo.status === "OPEN" || fo.status === "IN_PROGRESS") &&
      (fo.fulfillmentHolds?.length ?? 0) === 0, // idempotent: skip already-held
  );
  for (const fo of openOrders) {
    const data = await gql(client, mutation, {
      id: fo.id,
      fulfillmentHold: {
        reason: "OTHER",
        reasonNotes: "Layaway — ships at full payoff",
      },
    });
    const errors = data.fulfillmentOrderHold.userErrors;
    if (errors?.length) {
      console.warn("[layaway] hold error", fo.id, JSON.stringify(errors));
    }
  }
}

export async function releaseFulfillmentHolds(client, order) {
  const mutation = `#graphql
    mutation ReleaseLayawayHold($id: ID!) {
      fulfillmentOrderReleaseHold(id: $id) {
        userErrors { field message }
      }
    }
  `;
  const held = (order.fulfillmentOrders?.nodes ?? []).filter(
    (fo) => fo.status === "ON_HOLD",
  );
  for (const fo of held) {
    const data = await gql(client, mutation, { id: fo.id });
    const errors = data.fulfillmentOrderReleaseHold.userErrors;
    if (errors?.length) {
      console.warn("[layaway] release error", fo.id, JSON.stringify(errors));
    }
  }
}

// ---------- Installment engine (Order Edit ×N) ----------

/**
 * Adds a "Layaway payment #n" custom line item to the order via Order Edit,
 * creating an outstanding amount the customer (or POS) can pay natively.
 * Returns { ledger } after commit. NOTE (landmine from design): callers must
 * poll fetchOrder afterwards — orderEditCommit has no read-after-write guarantee.
 */
export async function addInstallment(client, orderGid, amount, options = {}) {
  const order = await fetchOrder(client, orderGid);
  if (!isLayawayOrder(order)) throw new Error("Not a layaway order");

  const existing = order.metafield?.value
    ? JSON.parse(order.metafield.value)
    : null;
  const ledger = computeLedger(order, existing);
  const balance = parseFloat(ledger.balance);
  const pendingDue = parseFloat(ledger.pending_due ?? "0");
  const requested = parseFloat(amount);

  if (!(requested > 0)) throw new Error("Amount must be positive");
  if (requested > balance + 0.005) {
    throw new Error(`Amount exceeds remaining balance ($${ledger.balance})`);
  }
  if (pendingDue > 0.01) {
    throw new Error(
      `This order already has $${ledger.pending_due} due — complete that payment first (Pay now online, or collect it in store).`,
    );
  }

  const beginData = await gql(
    client,
    `#graphql
    mutation Begin($id: ID!) {
      orderEditBegin(id: $id) {
        calculatedOrder { id }
        userErrors { field message }
      }
    }
  `,
    { id: order.id },
  );
  if (beginData.orderEditBegin.userErrors?.length) {
    throw new Error(JSON.stringify(beginData.orderEditBegin.userErrors));
  }
  const calcId = beginData.orderEditBegin.calculatedOrder.id;

  const n = (ledger.payments?.length ?? 0) + 1;
  const addData = await gql(
    client,
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
        userErrors { field message }
      }
    }
  `,
    {
      id: calcId,
      title: `Layaway payment #${n}`,
      price: {
        amount: requested.toFixed(2),
        currencyCode:
          options.currency ??
          order.presentmentCurrencyCode ??
          order.currencyCode ??
          "USD",
      },
      quantity: 1,
    },
  );
  if (addData.orderEditAddCustomItem.userErrors?.length) {
    throw new Error(JSON.stringify(addData.orderEditAddCustomItem.userErrors));
  }

  const commitData = await gql(
    client,
    `#graphql
    mutation Commit($id: ID!, $notify: Boolean, $note: String) {
      orderEditCommit(id: $id, notifyCustomer: $notify, staffNote: $note) {
        order { id }
        userErrors { field message }
      }
    }
  `,
    {
      id: calcId,
      notify: options.notifyCustomer ?? true,
      note: `Layaway installment #${n} of $${requested.toFixed(2)} (${options.channel ?? "web"})`,
    },
  );
  if (commitData.orderEditCommit.userErrors?.length) {
    throw new Error(JSON.stringify(commitData.orderEditCommit.userErrors));
  }

  return { orderId: order.id, installment: n, amount: requested.toFixed(2) };
}

/**
 * Cancels the pending (uncollected) "Layaway payment" line so a different
 * amount can be chosen. Only proceeds when the pending line exactly matches
 * the order's outstanding amount (i.e. it hasn't been paid).
 */
export async function cancelPendingInstallment(client, orderGid) {
  const order = await fetchOrder(client, orderGid);
  if (!isLayawayOrder(order)) throw new Error("Not a layaway order");
  const outstanding = parseFloat(
    order.totalOutstandingSet?.shopMoney?.amount ?? "0",
  );
  if (outstanding <= 0.01) throw new Error("No pending payment to cancel");

  const beginData = await gql(
    client,
    `#graphql
    mutation Begin($id: ID!) {
      orderEditBegin(id: $id) {
        calculatedOrder { id }
        userErrors { field message }
      }
    }
  `,
    { id: order.id },
  );
  if (beginData.orderEditBegin.userErrors?.length) {
    throw new Error(JSON.stringify(beginData.orderEditBegin.userErrors));
  }
  const calcId = beginData.orderEditBegin.calculatedOrder.id;

  const linesData = await gql(
    client,
    `#graphql
    query CalcLines($id: ID!) {
      node(id: $id) {
        ... on CalculatedOrder {
          lineItems(first: 50) {
            nodes {
              id
              title
              quantity
              originalUnitPriceSet { shopMoney { amount } }
            }
          }
        }
      }
    }
  `,
    { id: calcId },
  );
  const lines = linesData.node?.lineItems?.nodes ?? [];
  const target = lines.find(
    (line) =>
      line.title?.startsWith("Layaway payment") &&
      line.quantity > 0 &&
      Math.abs(
        parseFloat(line.originalUnitPriceSet?.shopMoney?.amount ?? "0") *
          line.quantity -
          outstanding,
      ) < 0.011,
  );
  if (!target) {
    throw new Error(
      "Could not identify the pending payment line to cancel — collect it instead",
    );
  }

  const setData = await gql(
    client,
    `#graphql
    mutation Zero($id: ID!, $lineItemId: ID!) {
      orderEditSetQuantity(id: $id, lineItemId: $lineItemId, quantity: 0) {
        userErrors { field message }
      }
    }
  `,
    { id: calcId, lineItemId: target.id },
  );
  if (setData.orderEditSetQuantity.userErrors?.length) {
    throw new Error(JSON.stringify(setData.orderEditSetQuantity.userErrors));
  }

  const commitData = await gql(
    client,
    `#graphql
    mutation Commit($id: ID!) {
      orderEditCommit(id: $id, notifyCustomer: false, staffNote: "Layaway pending payment canceled") {
        order { id }
        userErrors { field message }
      }
    }
  `,
    { id: calcId },
  );
  if (commitData.orderEditCommit.userErrors?.length) {
    throw new Error(JSON.stringify(commitData.orderEditCommit.userErrors));
  }

  return { canceled: outstanding.toFixed(2) };
}

// ---------- Webhook reconciliation ----------

/**
 * Idempotent sync: recompute the ledger from the order, tag it, manage holds.
 * Called from orders/create, orders/edited and order transaction webhooks.
 */
export async function syncLayawayOrder(client, orderId) {
  const order = await fetchOrder(client, orderId);
  if (!order || !isLayawayOrder(order)) return null;

  const existing = order.metafield?.value
    ? JSON.parse(order.metafield.value)
    : null;
  const ledger = computeLedger(order, existing);

  await writeLedger(client, order.id, ledger);
  if (!order.tags?.includes(LAYAWAY_TAG)) await tagOrder(client, order.id);

  if (ledger.status === "completed") {
    await releaseFulfillmentHolds(client, order);
  } else {
    await holdFulfillment(client, order);
  }

  console.log(
    `[layaway] synced ${order.name}: paid $${ledger.paid} / $${ledger.real_total}, balance $${ledger.balance}, status=${ledger.status}`,
  );
  return ledger;
}
