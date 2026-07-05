const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const {
  notifyCustomerShipping,
  trackingPageBase,
  detectCourierSync,
  isFallbackUrl,
  isKnownShop,
  getShopConfig,
} = require('../services/shopify');

// Best-effort dedup of Shopify webhook retries (in-memory, per instance)
const processedWebhooks = new Set();
function alreadyProcessed(webhookId) {
  if (!webhookId) return false;
  if (processedWebhooks.has(webhookId)) return true;
  processedWebhooks.add(webhookId);
  if (processedWebhooks.size > 500) {
    processedWebhooks.delete(processedWebhooks.values().next().value);
  }
  return false;
}

// Middleware to capture raw body for HMAC verification
router.use(
  express.raw({ type: 'application/json' })
);

// Helper: verify Shopify HMAC signature with the shop's own secret
// (each store signs its webhooks with a different secret)
function verifyShopifyWebhook(req, secret) {
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];

  if (!secret || !hmacHeader) return false;

  const digest = crypto
    .createHmac('sha256', secret)
    .update(req.body) // raw Buffer
    .digest('base64');

  const a = Buffer.from(digest);
  const b = Buffer.from(hmacHeader);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// GET  /api/webhook  — health check
router.get('/', (req, res) => {
  res.status(200).json({
    status: 'success',
    message: 'Webhook API is ready',
    timestamp: new Date().toISOString(),
  });
});

// POST /api/webhook  — receive Shopify fulfillment/creation events
router.post('/', async (req, res) => {
  const shopHeader = req.headers['x-shopify-shop-domain'] || 'unknown';

  // Verify signature with this shop's secret (skip if none configured, useful during dev)
  const { webhookSecret } = getShopConfig(shopHeader);
  if (webhookSecret) {
    if (!verifyShopifyWebhook(req, webhookSecret)) {
      console.warn(`⚠️  Invalid Shopify HMAC signature from ${shopHeader} – request rejected`);
      return res.status(401).json({ error: 'Unauthorized: invalid HMAC signature' });
    }
  }

  let payload;
  try {
    // req.body is a raw Buffer because of express.raw()
    payload = JSON.parse(req.body.toString('utf8'));
  } catch (err) {
    console.error('❌ Failed to parse webhook payload:', err.message);
    return res.status(400).json({ error: 'Bad Request: invalid JSON' });
  }

  const topic = req.headers['x-shopify-topic'] || 'unknown';
  const shop  = req.headers['x-shopify-shop-domain'] || 'unknown';

  console.log(`\n📦 Shopify Webhook Received`);
  console.log(`   Topic : ${topic}`);
  console.log(`   Shop  : ${shop}`);
  console.log(`   Data  :`, JSON.stringify(payload, null, 2));

  // --- Handle fulfillment events (manual fulfillments AND shipping apps) ---
  // fulfillments/create → order went unfulfilled → fulfilled
  // fulfillments/update → tracking number added/changed later by an app
  if (topic === 'fulfillments/create' || topic === 'fulfillments/update') {
    const { id, order_id, status, tracking_number, tracking_company, tracking_url, line_items } = payload;

    console.log(`\n🚚 Fulfillment Event (${topic})`);
    console.log(`   Fulfillment ID   : ${id}`);
    console.log(`   Order ID         : ${order_id}`);
    console.log(`   Status           : ${status}`);
    console.log(`   Tracking Number  : ${tracking_number}`);
    console.log(`   Tracking Company : ${tracking_company}`);
    console.log(`   Tracking URL     : ${tracking_url}`);
    console.log(`   Line Items       : ${line_items?.length ?? 0} item(s)`);

    const webhookId = req.headers['x-shopify-webhook-id'];

    // Loop guard: our own update_tracking call fires fulfillments/update.
    // Skip when the tracking URL is already what we would set:
    //  - our tracking page (RajaOngkir-supported couriers)
    //  - any official-site fallback URL (couriers RajaOngkir can't track)
    //  - any URL on an undetectable courier (GoSend etc.) — we keep those as-is
    const detected = detectCourierSync(tracking_company, tracking_number);
    const isOwnUpdate =
      topic === 'fulfillments/update' &&
      typeof tracking_url === 'string' &&
      (tracking_url.startsWith(trackingPageBase(shop)) ||
        isFallbackUrl(tracking_url) ||
        (!detected.courier && !detected.fallback));

    if (status === 'cancelled' || status === 'error' || status === 'failure') {
      console.log(`   ⏭️  Skipping notification (fulfillment status: ${status})`);
    } else if (!isKnownShop(shop)) {
      console.warn(`   ⏭️  Skipping notification (shop ${shop} not in SHOP env allowlist)`);
    } else if (isOwnUpdate) {
      console.log('   ⏭️  Skipping notification (update triggered by our own tracking update)');
    } else if (alreadyProcessed(webhookId)) {
      console.log('   ⏭️  Skipping notification (duplicate webhook delivery)');
    } else {
      try {
        const { trackingPageUrl, courier } = await notifyCustomerShipping({
          shopDomain: shop,
          fulfillmentId: id,
          orderId: order_id,
          trackingNumber: tracking_number,
          trackingCompany: tracking_company,
          destinationPhone: payload.destination?.phone,
          existingTrackingUrl: tracking_url,
        });
        console.log(`   ✅ Shopify shipping email sent to customer`);
        console.log(`   🚛 Courier slug   : ${courier || '(unsupported — plain page link)'}`);
        console.log(`   🔗 Tracking link in email: ${trackingPageUrl}`);
      } catch (err) {
        // Log but still return 200 — a 5xx would make Shopify retry the webhook
        console.error(`   ❌ Failed to send shipping notification: ${err.message}`);
      }
    }
  }

  // Shopify requires a 200 response quickly
  res.status(200).json({ received: true });
});

module.exports = router;
