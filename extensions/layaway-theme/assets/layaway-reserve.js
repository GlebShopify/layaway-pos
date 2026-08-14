/**
 * Layaway "Pay With Reserve" storefront experience.
 *
 * Flow (WEB_DESIGN.md §4): cart link → Enter Down Payment modal →
 * write layaway_* cart attributes + line item properties (same schema as
 * the POS extension) → redirect to /checkout.
 */
(function () {
  var CONFIG = window.LAYAWAY_CONFIG || {};
  var MIN_PCT = Number(CONFIG.minPct || 10);
  var DEFAULT_PCT = Number(CONFIG.defaultPct || 10);
  var DUE_DAYS = Number(CONFIG.balanceDueDays || 60);

  function money(n) {
    return '$' + Number(n).toFixed(2);
  }

  function fetchCart() {
    return fetch('/cart.js').then(function (r) { return r.json(); });
  }

  // ---------- link injection ----------

  function injectLinks() {
    // Inject next to any checkout button (cart page + most cart drawers).
    var buttons = document.querySelectorAll(
      'button[name="checkout"], input[name="checkout"], a[href="/checkout"]'
    );
    buttons.forEach(function (btn) {
      if (btn.dataset.layawayLinked) return;
      btn.dataset.layawayLinked = '1';
      var link = document.createElement('button');
      link.type = 'button';
      link.className = 'layaway-reserve-link';
      link.textContent = 'Pay With Reserve';
      link.addEventListener('click', function (e) {
        e.preventDefault();
        openModal();
      });
      btn.parentNode.insertBefore(link, btn.nextSibling);
    });
  }

  // ---------- modal ----------

  var overlay = null;

  function openModal() {
    fetchCart().then(function (cart) {
      if (!cart.items || cart.items.length === 0) return;
      renderModal(cart);
    });
  }

  function closeModal() {
    if (overlay) {
      overlay.remove();
      overlay = null;
    }
  }

  function renderModal(cart) {
    closeModal();
    var total = cart.total_price / 100; // cart total (pre shipping/checkout tax)
    var minDeposit = (total * MIN_PCT) / 100;
    var defaultDeposit = ((total * DEFAULT_PCT) / 100).toFixed(2);
    var dueDate = new Date(Date.now() + DUE_DAYS * 24 * 60 * 60 * 1000);
    var dueDateLabel = dueDate.toLocaleDateString(undefined, {
      year: 'numeric', month: 'long', day: 'numeric'
    });

    overlay = document.createElement('div');
    overlay.className = 'layaway-overlay';
    overlay.innerHTML =
      '<div class="layaway-modal" role="dialog" aria-label="Enter Down Payment">' +
      '  <button class="layaway-close" aria-label="Close">&times;</button>' +
      '  <h2>Enter Down Payment</h2>' +
      '  <div class="layaway-amount-wrap">$ <input type="number" step="0.01" min="0" id="layaway-amount" value="' + defaultDeposit + '"></div>' +
      '  <p class="layaway-hint" id="layaway-hint">' + MIN_PCT + '% minimum down payment required</p>' +
      '  <div class="layaway-summary">' +
      '    <div class="layaway-summary-row"><span>Reserve Total</span><span>' + money(total) + '</span></div>' +
      '    <div class="layaway-summary-row"><span>Tax</span><span>Calculated on Checkout</span></div>' +
      '    <div class="layaway-summary-row"><span>Shipping</span><span>Calculated on Checkout</span></div>' +
      '    <div class="layaway-summary-row"><span>Total</span><span>' + money(total) + '</span></div>' +
      '    <div class="layaway-summary-row layaway-strong"><span>Due Today</span><span id="layaway-due-today">' + money(defaultDeposit) + '</span></div>' +
      '    <div class="layaway-summary-row"><span>Remaining balance due by ' + dueDateLabel + '</span><span id="layaway-remaining">' + money(total - defaultDeposit) + '</span></div>' +
      '  </div>' +
      '  <div class="layaway-notice">&#128161; Your item will be shipped once your final payment has been made. Failure to pay by the due date, canceling the order, or returning the item will result in a <strong>' + MIN_PCT + '% (' + money(minDeposit) + ') cancellation/restocking fee.</strong></div>' +
      '  <label class="layaway-terms"><input type="checkbox" id="layaway-terms"> <span>By Checking This Box, You Agree To Our ' +
      (CONFIG.termsUrl ? '<a href="' + CONFIG.termsUrl + '" target="_blank">Reserve Terms.</a>' : 'Reserve Terms.') +
      '  </span></label>' +
      '  <div class="layaway-actions">' +
      '    <button class="layaway-btn layaway-btn-plain" id="layaway-cancel">Cancel</button>' +
      '    <button class="layaway-btn layaway-btn-primary" id="layaway-checkout" disabled>Checkout</button>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(overlay);

    var amountInput = overlay.querySelector('#layaway-amount');
    var hint = overlay.querySelector('#layaway-hint');
    var dueToday = overlay.querySelector('#layaway-due-today');
    var remaining = overlay.querySelector('#layaway-remaining');
    var terms = overlay.querySelector('#layaway-terms');
    var checkoutBtn = overlay.querySelector('#layaway-checkout');

    function currentAmount() {
      return parseFloat(amountInput.value) || 0;
    }

    function validate() {
      var amount = currentAmount();
      var valid = amount >= minDeposit - 0.005 && amount <= total + 0.005;
      if (amount < minDeposit) {
        hint.textContent = MIN_PCT + '% minimum down payment required (' + money(minDeposit) + ')';
        hint.classList.add('layaway-error');
      } else if (amount > total) {
        hint.textContent = 'Down payment cannot exceed the reserve total (' + money(total) + ')';
        hint.classList.add('layaway-error');
      } else {
        hint.textContent = MIN_PCT + '% minimum down payment required';
        hint.classList.remove('layaway-error');
      }
      dueToday.textContent = money(Math.min(amount, total));
      remaining.textContent = money(Math.max(total - amount, 0));
      checkoutBtn.disabled = !(valid && terms.checked);
      return valid;
    }

    amountInput.addEventListener('input', validate);
    terms.addEventListener('change', validate);
    overlay.querySelector('.layaway-close').addEventListener('click', closeModal);
    overlay.querySelector('#layaway-cancel').addEventListener('click', closeModal);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeModal();
    });

    checkoutBtn.addEventListener('click', function () {
      if (!validate()) return;
      checkoutBtn.disabled = true;
      checkoutBtn.textContent = 'Preparing…';
      startLayaway(cart, currentAmount(), total).then(function () {
        window.location.href = '/checkout';
      }).catch(function (err) {
        checkoutBtn.disabled = false;
        checkoutBtn.textContent = 'Checkout';
        hint.textContent = 'Something went wrong: ' + err.message;
        hint.classList.add('layaway-error');
      });
    });

    validate();
  }

  // ---------- cart mutation (same schema as POS extension) ----------

  function startLayaway(cart, deposit, total) {
    var balance = Math.max(total - deposit, 0);
    var pct = total > 0 ? ((deposit / total) * 100).toFixed(1) : '0';
    var attributes = {
      layaway: 'true',
      layaway_status: 'deposit_pending',
      layaway_total: total.toFixed(2),
      layaway_deposit: deposit.toFixed(2),
      layaway_deposit_pct: pct,
      layaway_balance: balance.toFixed(2),
      layaway_created_at: new Date().toISOString(),
      layaway_channel: 'web'
    };

    // 1. Cart attributes → order note attributes (the ledger seed).
    var updateAttributes = fetch('/cart/update.js', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({attributes: attributes})
    }).then(function (r) {
      if (!r.ok) throw new Error('cart attributes failed');
      return r.json();
    });

    // 2. Line item properties, one line at a time (matches POS line props).
    return updateAttributes.then(function () {
      return cart.items.reduce(function (chain, item, index) {
        return chain.then(function () {
          var properties = Object.assign({}, item.properties || {}, {
            layaway: 'true',
            layaway_deposit: deposit.toFixed(2),
            layaway_balance: balance.toFixed(2)
          });
          return fetch('/cart/change.js', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({line: index + 1, properties: properties})
          }).then(function (r) {
            if (!r.ok) throw new Error('line properties failed');
          });
        });
      }, Promise.resolve());
    });
  }

  // ---------- boot ----------

  function boot() {
    injectLinks();
    // Re-inject when cart drawers re-render.
    var observer = new MutationObserver(function () {
      injectLinks();
    });
    observer.observe(document.body, {childList: true, subtree: true});
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
