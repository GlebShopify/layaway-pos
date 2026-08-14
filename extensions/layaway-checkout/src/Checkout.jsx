import '@shopify/ui-extensions/preact';
import {render} from 'preact';

export default async () => {
  render(<Extension />, document.body);
};

function money(value) {
  const n = parseFloat(value ?? '0');
  return `$${(Number.isFinite(n) ? n : 0).toFixed(2)}`;
}

function Extension() {
  const attributes = shopify.attributes.value ?? [];
  const attr = (key) => attributes.find((a) => a.key === key)?.value;

  // Only render for layaway carts (attributes written by the storefront
  // "Pay With Reserve" modal or the POS Layaway tile).
  if (attr('layaway') !== 'true') {
    return null;
  }

  const total = attr('layaway_total');
  const deposit = attr('layaway_deposit');
  const balance = attr('layaway_balance');
  const pct = attr('layaway_deposit_pct');

  return (
    <s-banner heading="Layaway reserve" tone="info">
      <s-stack gap="small-200">
        <s-stack direction="inline" gap="small-200">
          <s-text>Reserve total:</s-text>
          <s-text fontWeight="bold">{money(total)}</s-text>
        </s-stack>
        <s-stack direction="inline" gap="small-200">
          <s-text>{`Due today (${pct ?? '—'}% deposit):`}</s-text>
          <s-text fontWeight="bold">{money(deposit)}</s-text>
        </s-stack>
        <s-stack direction="inline" gap="small-200">
          <s-text>Remaining balance after this payment:</s-text>
          <s-text fontWeight="bold">{money(balance)}</s-text>
        </s-stack>
        <s-text>
          Your item ships once the full balance is paid. Pay the remainder any
          time from your account or in store.
        </s-text>
      </s-stack>
    </s-banner>
  );
}
