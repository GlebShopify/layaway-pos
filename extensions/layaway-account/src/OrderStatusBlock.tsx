import '@shopify/ui-extensions/preact';
import {render} from 'preact';
import {useState, useEffect} from 'preact/hooks';

// Layaway backend (P1). NOTE: trycloudflare URL changes when the tunnel
// restarts — update BACKEND_URL + redeploy if the demo tunnel is recreated.
const BACKEND_URL = 'https://ebooks-statistics-janet-latex.trycloudflare.com';
const SHOP = 'se-shopvip-en-cten.myshopify.com';

export default async () => {
  render(<Extension />, document.body);
};

function money(value) {
  const n = parseFloat(value ?? '0');
  return `$${(Number.isFinite(n) ? n : 0).toFixed(2)}`;
}

function Extension() {
  const [ledger, setLedger] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [amount, setAmount] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const order = shopify.order.value;
  const orderId = order?.id ? order.id.split('/').pop() : null;

  useEffect(() => {
    if (!orderId) return;
    fetch(`${BACKEND_URL}/api/layaway/${orderId}?shop=${SHOP}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.ledger) setLedger(data.ledger);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [orderId]);

  // Not a layaway order (or backend unreachable): render nothing.
  if (loading || !ledger) return null;

  const balance = parseFloat(ledger.balance);
  const paid = parseFloat(ledger.paid);
  const total = parseFloat(ledger.real_total);
  const parsedAmount = parseFloat(amount) || 0;
  const amountValid = parsedAmount > 0 && parsedAmount <= balance + 0.005;
  const amountError =
    amount !== '' && !amountValid
      ? `Enter an amount between $0.01 and ${money(balance)}`
      : undefined;

  async function submitPayment() {
    setSubmitting(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await fetch(
        `${BACKEND_URL}/api/layaway/${orderId}/payment`,
        {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            amount: parsedAmount.toFixed(2),
            shop: SHOP,
            channel: 'customer_account',
          }),
        },
      );
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'Payment request failed');
      setSuccess(
        `Installment #${result.installment} for ${money(result.amount)} was added to your order. ` +
          'Refresh this page in a moment and use "Pay now" to complete it — we also emailed you the payment link.',
      );
      setAmount('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Payment request failed');
    } finally {
      setSubmitting(false);
    }
  }

  if (ledger.status === 'completed') {
    return (
      <s-section heading="Installment plan">
        <s-banner tone="success" heading="Paid in full">
          <s-paragraph>
            {`All ${money(total)} has been paid. Your order will ship shortly.`}
          </s-paragraph>
        </s-banner>
      </s-section>
    );
  }

  return (
    <s-section heading="Installment plan">
      <s-stack gap="base">
        <s-stack direction="inline" gap="large-100">
          <s-stack gap="small-300">
            <s-text color="subdued">Remaining balance</s-text>
            <s-heading>{money(balance)}</s-heading>
          </s-stack>
          <s-stack gap="small-300">
            <s-text color="subdued">Paid so far</s-text>
            <s-text>{`${money(paid)} of ${money(total)}`}</s-text>
          </s-stack>
        </s-stack>

        {ledger.payments?.length > 0 && (
          <s-stack gap="small-300">
            <s-heading>Payment history</s-heading>
            {ledger.payments.map((p: any) => (
              <s-text key={p.txn_id}>
                {`#${p.n} · ${money(p.amount)} · ${new Date(p.at).toLocaleDateString()}`}
              </s-text>
            ))}
          </s-stack>
        )}

        {success && (
          <s-banner tone="success" heading="Payment requested">
            <s-paragraph>{success}</s-paragraph>
          </s-banner>
        )}

        <s-button command="--show" commandFor="layaway-pay-modal" variant="primary">
          Make a payment
        </s-button>

        <s-modal id="layaway-pay-modal" heading="Make a payment">
          <s-stack gap="base">
            <s-paragraph>
              {`Remaining balance: ${money(balance)}. Choose how much to pay today.`}
            </s-paragraph>
            <s-stack direction="inline" gap="small-200">
              <s-button onClick={() => setAmount((balance * 0.25).toFixed(2))}>
                25%
              </s-button>
              <s-button onClick={() => setAmount((balance * 0.5).toFixed(2))}>
                50%
              </s-button>
              <s-button onClick={() => setAmount(balance.toFixed(2))}>
                Pay in full
              </s-button>
            </s-stack>
            <s-number-field
              label="Payment amount"
              value={amount}
              error={amountError}
              onInput={(event) => setAmount((event.currentTarget as unknown as {value?: string})?.value ?? '')}
            />
            {error && (
              <s-banner tone="critical" heading="Could not request payment">
                <s-paragraph>{error}</s-paragraph>
              </s-banner>
            )}
            <s-button
              variant="primary"
              disabled={!amountValid || submitting}
              loading={submitting}
              onClick={() => submitPayment()}
            >
              {`Request payment${amountValid ? ` of ${money(parsedAmount)}` : ''}`}
            </s-button>
          </s-stack>
        </s-modal>
      </s-stack>
    </s-section>
  );
}
