const m = require('mongoose');
(async () => {
  await m.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  const c = m.connection.db.collection('systemlogs');
  await c.insertOne({
    level: 'error',
    message: '[PAYMENT-VERIFY] Payment captured but provisioning failed: Order validation failed: razorpaySignature: Path `razorpaySignature` is required.',
    source: 'payments/verify', service: 'payments',
    metadata: { orderId: 'PROBE-ONLY', razorpayPaymentId: 'pay_PROBE' },
    createdAt: new Date(), updatedAt: new Date(),
  });
  console.log('probe SystemLog inserted');
  await m.disconnect();
})().catch(e => { console.log('ERR ' + e.message.slice(0,160)); process.exit(1); });
