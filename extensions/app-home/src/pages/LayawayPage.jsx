import {useState, useEffect} from 'preact/hooks';

const LAYAWAY_ORDERS_QUERY = `#graphql
  query LayawayOrders {
    orders(first: 50, query: "tag:layaway", sortKey: CREATED_AT, reverse: true) {
      nodes {
        id
        legacyResourceId
        name
        createdAt
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
          }
        }
        metafield(namespace: "$app:layaway", key: "ledger") {
          value
        }
      }
    }
  }
`;

function money(amount) {
  const n = typeof amount === 'string' ? parseFloat(amount) : (amount ?? 0);
  return `$${(Number.isFinite(n) ? n : 0).toFixed(2)}`;
}

function attr(order, key) {
  return order.customAttributes?.find((a) => a.key === key)?.value;
}

function toRow(order) {
  const ledger = order.metafield?.value ? JSON.parse(order.metafield.value) : null;
  const total = parseFloat(
    ledger?.real_total ??
      attr(order, 'layaway_total') ??
      order.totalPriceSet?.shopMoney?.amount ??
      '0',
  );
  const balance = parseFloat(
    ledger?.balance ?? order.totalOutstandingSet?.shopMoney?.amount ?? '0',
  );
  const paid = parseFloat(ledger?.paid ?? Math.max(total - balance, 0));
  return {
    id: order.legacyResourceId,
    name: order.name,
    createdAt: new Date(ledger?.created_at ?? order.createdAt),
    customer: order.customer?.displayName ?? 'No customer',
    email: order.customer?.email ?? '',
    channel: ledger?.channel ?? attr(order, 'layaway_channel') ?? '—',
    status: ledger?.status ?? (balance > 0 ? 'active' : 'completed'),
    payments: ledger?.payments?.length ?? 0,
    total,
    paid,
    balance,
  };
}

export default function LayawayPage() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('shopify:admin/api/2026-07/graphql.json', {
        method: 'POST',
        body: JSON.stringify({query: LAYAWAY_ORDERS_QUERY}),
      });
      const result = await response.json();
      if (result.errors?.length) throw new Error(result.errors[0].message);
      setRows(result.data.orders.nodes.map(toRow));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load layaway orders');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const active = rows.filter((r) => r.status === 'active');
  const completed = rows.filter((r) => r.status === 'completed');
  const outstanding = active.reduce((sum, r) => sum + r.balance, 0);
  const collected = rows.reduce((sum, r) => sum + r.paid, 0);

  return (
    <s-page heading="Layaway">
      <s-button slot="primary-action" onClick={load} disabled={loading}>
        Refresh
      </s-button>

      <s-section heading="Overview">
        <s-grid gridTemplateColumns="1fr 1fr 1fr 1fr" gap="base">
          <s-box padding="base" borderRadius="base" background="subdued">
            <s-stack gap="small-300">
              <s-text color="subdued">Active layaways</s-text>
              <s-heading>{String(active.length)}</s-heading>
            </s-stack>
          </s-box>
          <s-box padding="base" borderRadius="base" background="subdued">
            <s-stack gap="small-300">
              <s-text color="subdued">Outstanding balance</s-text>
              <s-heading>{money(outstanding)}</s-heading>
            </s-stack>
          </s-box>
          <s-box padding="base" borderRadius="base" background="subdued">
            <s-stack gap="small-300">
              <s-text color="subdued">Collected to date</s-text>
              <s-heading>{money(collected)}</s-heading>
            </s-stack>
          </s-box>
          <s-box padding="base" borderRadius="base" background="subdued">
            <s-stack gap="small-300">
              <s-text color="subdued">Completed</s-text>
              <s-heading>{String(completed.length)}</s-heading>
            </s-stack>
          </s-box>
        </s-grid>
      </s-section>

      {error && (
        <s-section>
          <s-banner tone="critical" heading="Could not load layaway orders">
            {error}
          </s-banner>
        </s-section>
      )}

      <s-section heading={`Layaway orders (${rows.length})`}>
        {loading && <s-text>Loading layaway orders…</s-text>}
        {!loading && rows.length === 0 && (
          <s-paragraph>
            No layaway orders yet. Create one from the Layaway tile on POS —
            orders are tagged <s-text fontWeight="bold">layaway</s-text>{' '}
            automatically by the backend.
          </s-paragraph>
        )}
        {!loading && rows.length > 0 && (
          <s-table>
            <s-table-header-row>
              <s-table-header>Order</s-table-header>
              <s-table-header>Created</s-table-header>
              <s-table-header>Customer</s-table-header>
              <s-table-header>Channel</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Payments</s-table-header>
              <s-table-header>Total</s-table-header>
              <s-table-header>Paid</s-table-header>
              <s-table-header>Balance</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {rows.map((row) => (
                <s-table-row key={row.id}>
                  <s-table-cell>
                    <s-link href={`shopify://admin/orders/${row.id}`}>
                      {row.name}
                    </s-link>
                  </s-table-cell>
                  <s-table-cell>
                    {row.createdAt.toLocaleDateString()}
                  </s-table-cell>
                  <s-table-cell>{row.customer}</s-table-cell>
                  <s-table-cell>{row.channel.toUpperCase()}</s-table-cell>
                  <s-table-cell>
                    <s-badge
                      tone={row.status === 'completed' ? 'success' : 'warning'}
                    >
                      {row.status === 'completed' ? 'Completed' : 'Active'}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>{String(row.payments)}</s-table-cell>
                  <s-table-cell>{money(row.total)}</s-table-cell>
                  <s-table-cell>{money(row.paid)}</s-table-cell>
                  <s-table-cell>
                    <s-text fontWeight="bold">{money(row.balance)}</s-text>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}
