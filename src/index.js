const express = require('express');
const dotenv = require('dotenv');
const webhookRoutes = require('./routes/webhook');

const app = express();
const port = process.env.PORT || 3000;
dotenv.config();


app.use(express.urlencoded({ extended: true }));

// NOTE: Do NOT add express.json() globally before webhook routes —
// the webhook router uses express.raw() to preserve the raw body
// needed for Shopify HMAC signature verification.
app.use((req, res, next) => {
  if (req.path.startsWith('/api/webhook')) return next();
  express.json()(req, res, next);
});

// Routes
app.get("/", (req, res) => {
  res.send("Express API running 🚀");
});

app.post("/", express.raw({ type: 'application/json' }), (req, res) => {
  let payload;
  try {
    payload = JSON.parse(req.body.toString('utf8'));
  } catch (e) {
    payload = req.body;
  }

  const topic = req.headers['x-shopify-topic'] || 'unknown';
  const shop  = req.headers['x-shopify-shop-domain'] || 'unknown';

  console.log('\n========================================');
  console.log(`📦 Shopify Webhook @ POST /`);
  console.log(`   Topic : ${topic}`);
  console.log(`   Shop  : ${shop}`);
  console.log('   Payload:');
  console.log(JSON.stringify(payload, null, 2));
  console.log('========================================\n');

  res.status(200).json({ received: true });
});

// Use the webhook routes
app.use('/api/webhook', webhookRoutes);

app.listen(port, () => {
  console.log(`EXPRESS API IS RUNNING ON PORT ${port}`)
})

module.exports = app;
