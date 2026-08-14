// @ts-check

/**
 * Layaway deposit-as-product (WEB_DESIGN.md §4, Option C).
 *
 * When the storefront "Pay With Reserve" modal marks a cart as a WEB layaway,
 * this function reprices every line so checkout charges only the deposit.
 * The deposit is allocated across lines proportionally to their value; the
 * last line absorbs rounding remainders.
 *
 * POS layaway carts (layaway_channel=pos) are never touched — POS relies on
 * native full-total + partial payment capture at the drawer.
 *
 * @typedef {import("../generated/api").CartTransformRunInput} CartTransformRunInput
 * @typedef {import("../generated/api").CartTransformRunResult} CartTransformRunResult
 * @typedef {import("../generated/api").Operation} Operation
 */

/**
 * @type {CartTransformRunResult}
 */
const NO_CHANGES = {
  operations: [],
};

/**
 * @param {number} n
 */
function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * @param {CartTransformRunInput} input
 * @returns {CartTransformRunResult}
 */
export function cartTransformRun(input) {
  const cart = input.cart;

  const isLayaway = cart.layaway?.value === "true";
  const isWeb = cart.channel?.value === "web";
  const deposit = parseFloat(cart.deposit?.value ?? "");

  if (!isLayaway || !isWeb || !(deposit > 0)) {
    return NO_CHANGES;
  }

  const lines = cart.lines;
  const cartTotal = lines.reduce(
    (sum, line) => sum + parseFloat(line.cost.totalAmount.amount),
    0,
  );

  // Never increase prices; only reprice when the deposit is below the total.
  if (!(cartTotal > 0) || deposit >= cartTotal) {
    return NO_CHANGES;
  }

  /** @type {Operation[]} */
  const operations = [];
  let allocated = 0;

  lines.forEach((line, index) => {
    const lineTotal = parseFloat(line.cost.totalAmount.amount);
    const isLast = index === lines.length - 1;
    const share = isLast
      ? deposit - allocated
      : round2((lineTotal / cartTotal) * deposit);
    const perUnit = Math.max(round2(share / line.quantity), 0);
    allocated = round2(allocated + perUnit * line.quantity);

    operations.push({
      lineUpdate: {
        cartLineId: line.id,
        price: {
          adjustment: {
            fixedPricePerUnit: {
              amount: perUnit.toFixed(2),
            },
          },
        },
      },
    });
  });

  return { operations };
}
