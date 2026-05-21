const express = require('express');
const dotenv = require('dotenv');
const webhookRoutes = require('./routes/webhook');

const app = express();
const port = process.env.PORT || 3000;
dotenv.config();


app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Routes
app.get("/", (req, res) => {
  res.send("Express API running 🚀");
});

// Use the webhook routes
app.use('/api/webhook', webhookRoutes);

app.listen(port, () => {
  console.log(`EXPRESS API IS RUNNING ON PORT ${port}`)
})

module.exports = app;
