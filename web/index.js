import "dotenv/config";
import express from "express";
import { shopifyApp } from "@shopify/shopify-app-express";
import { SQLiteSessionStorage } from "@shopify/shopify-app-session-storage-sqlite";
import { DeliveryMethod } from "@shopify/shopify-api";
import { addInstallment, cancelPendingInstallment, syncLayawayOrder, fetchOrder, computeLedger } from "./layaway.js";

const PORT = parseInt(process.env.PORT ?? "3000", 10);

const shopify = shopifyApp({
  api: {
    apiKey: process.env.SHOPIFY_API_KEY,
    apiSecretKey: process.env.SHOPIFY_API_SECRET,
    scopes: (process.env.SCOPES ?? "read_orders,read_all_orders,write_orders,read_customers,write_merchant_managed_fulfillment_orders").split(","),
    hostScheme: (process.env.SHOPIFY_APP_URL ?? "").startsWith("http://") ? "http" : "https",
    hostName: (process.env.SHOPIFY_APP_URL ?? `localhost:${PORT}`).replace(/^https?:\/\//, ""),
  },
  auth: {
    path: "/api/auth",
    callbackPath: "/api/auth/callback",
  },
  webhooks: {
    path: "/webhooks",
  },
  sessionStorage: new SQLiteSessionStorage("./layaway-sessions.sqlite"),
});

// ---------- helper: offline admin GraphQL client for a shop ----------
async function adminClient(shop) {
  const sessionId = shopify.api.session.getOfflineId(shop);
  const session = await shopify.config.sessionStorage.loadSession(sessionId);
  if (!session) throw new Error(`No offline session for ${shop} — visit /api/auth?shop=${shop}`);
  return new shopify.api.clients.Graphql({ session });
}

// ---------- webhook handlers ----------
const webhookHandlers = {
  ORDERS_CREATE: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: "/webhooks",
    callback: async (_topic, shop, body) => {
      const order = JSON.parse(body);
      const isLayaway = (order.note_attributes ?? []).some(
        (a) => a.name === "layaway" && a.value === "true",
      );
      if (!isLayaway) return;
      console.log(`[layaway] orders/create ${order.name} on ${shop}`);
      const client = await adminClient(shop);
      await syncLayawayOrder(client, order.admin_graphql_api_id);
    },
  },
  ORDERS_EDITED: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: "/webhooks",
    callback: async (_topic, shop, body) => {
      const payload = JSON.parse(body);
      const orderId = payload.order_edit?.order_id;
      if (!orderId) return;
      const client = await adminClient(shop);
      await syncLayawayOrder(client, orderId);
    },
  },
  ORDERS_PAID: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: "/webhooks",
    callback: async (_topic, shop, body) => {
      const order = JSON.parse(body);
      const client = await adminClient(shop);
      await syncLayawayOrder(client, order.admin_graphql_api_id);
    },
  },
  ORDER_TRANSACTIONS_CREATE: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: "/webhooks",
    callback: async (_topic, shop, body) => {
      const txn = JSON.parse(body);
      if (txn.status !== "success") return;
      const client = await adminClient(shop);
      await syncLayawayOrder(client, txn.order_id);
    },
  },
};

// ---------- express app ----------
const app = express();

app.get(shopify.config.auth.path, shopify.auth.begin());
app.get(
  shopify.config.auth.callbackPath,
  shopify.auth.callback(),
  shopify.redirectToShopifyOrAppRoot(),
);
app.post(
  shopify.config.webhooks.path,
  shopify.processWebhooks({ webhookHandlers }),
);

app.use(express.json());

// CORS for UI extensions (customer accounts / POS) calling the layaway API.
app.use("/api/layaway", (req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ---------- Layaway API (used by customer account + POS extensions) ----------

/**
 * GET /api/layaway/:orderId?shop=xxx.myshopify.com
 * Returns the current ledger for an order.
 */
app.get("/api/layaway/:orderId", async (req, res) => {
  try {
    const shop = req.query.shop;
    if (!shop) return res.status(400).json({ error: "shop param required" });
    const client = await adminClient(shop);
    const order = await fetchOrder(client, req.params.orderId);
    if (!order) return res.status(404).json({ error: "order not found" });
    const existing = order.metafield?.value ? JSON.parse(order.metafield.value) : null;
    res.json({ order: order.name, ledger: computeLedger(order, existing) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/layaway/:orderId/payment { amount, shop, channel? }
 * The installment engine (design §5): Order Edit adds "Layaway payment #n"
 * = amount → creates outstanding → customer pays natively (invoice email /
 * customer account Pay now / POS Collect payment).
 */
app.post("/api/layaway/:orderId/payment", async (req, res) => {
  try {
    const { amount, shop, channel, currency, notifyCustomer } = req.body ?? {};
    if (!shop) return res.status(400).json({ error: "shop required" });
    if (!amount) return res.status(400).json({ error: "amount required" });
    const client = await adminClient(shop);
    const result = await addInstallment(client, req.params.orderId, amount, {
      channel,
      currency,
      notifyCustomer,
    });
    // Landmine (design §7): poll after orderEditCommit — no read-after-write
    // guarantee. Re-sync ledger after a short delay.
    setTimeout(() => {
      syncLayawayOrder(client, req.params.orderId).catch((e) =>
        console.warn("[layaway] post-commit sync failed:", e.message),
      );
    }, 3000);
    res.json(result);
  } catch (e) {
    res.status(422).json({ error: e.message });
  }
});

/**
 * POST /api/layaway/:orderId/payment/cancel { shop }
 * Cancels the pending (uncollected) installment so a new amount can be chosen.
 */
app.post("/api/layaway/:orderId/payment/cancel", async (req, res) => {
  try {
    const { shop } = req.body ?? {};
    if (!shop) return res.status(400).json({ error: "shop required" });
    const client = await adminClient(shop);
    const result = await cancelPendingInstallment(client, req.params.orderId);
    setTimeout(() => {
      syncLayawayOrder(client, req.params.orderId).catch(() => {});
    }, 3000);
    res.json(result);
  } catch (e) {
    res.status(422).json({ error: e.message });
  }
});

app.get("/healthz", (_req, res) => res.json({ ok: true, app: "layaway-backend" }));

app.listen(PORT, () => {
  console.log(`[layaway] backend listening on :${PORT}`);
  console.log(`[layaway] auth:    GET  /api/auth?shop=<shop>.myshopify.com`);
  console.log(`[layaway] webhook: POST /webhooks`);
  console.log(`[layaway] api:     GET/POST /api/layaway/:orderId[/payment]`);
});
