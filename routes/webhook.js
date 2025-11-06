// routes/webhook.js
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { pool } = require('../config/database');

// Verify PayMongo webhook signature
function verifyWebhookSignature(payload, signature) {
  const computedSignature = crypto
    .createHmac('sha256', process.env.PAYMONGO_WEBHOOK_SECRET)
    .update(payload)
    .digest('hex');
  
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(computedSignature)
  );
}

router.post('/paymongo', express.raw({ type: 'application/json' }), async (req, res) => {
  const client = await pool.connect();
  
  try {
    const signature = req.headers['paymongo-signature'];
    const payload = req.body.toString('utf8');
    
    // Verify webhook signature
    if (!verifyWebhookSignature(payload, signature)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }
    
    const event = JSON.parse(payload);
    const eventType = event.data.attributes.type;
    
    console.log('Webhook received:', eventType);
    
    // Handle different event types
    if (eventType === 'checkout_session.payment.paid') {
      await handlePaymentSuccess(event, client);
    } else if (eventType === 'payment.paid') {
      await handleDirectPaymentSuccess(event, client);
    } else if (eventType === 'payment.failed') {
      await handlePaymentFailed(event, client);
    }
    
    res.json({ received: true });
    
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

async function handlePaymentSuccess(event, client) {
  await client.query('BEGIN');
  
  try {
    const checkoutSession = event.data.attributes.data;
    const metadata = checkoutSession.attributes.metadata;
    const payment_id = parseInt(metadata.payment_id);
    const enrollment_id = parseInt(metadata.enrollment_id);
    const payment_type = metadata.payment_type;
    
    // 1. Get payment details
    const paymentResult = await client.query(`
      SELECT p.*, a.total_balance, a.student_id
      FROM payments p
      JOIN accounts a ON p.account_id = a.account_id
      WHERE p.payment_id = $1
    `, [payment_id]);
    
    if (paymentResult.rows.length === 0) {
      throw new Error('Payment not found');
    }
    
    const payment = paymentResult.rows[0];
    const amount = parseFloat(payment.amount);
    const current_balance = parseFloat(payment.total_balance);
    
    // 2. Update payment status
    await client.query(`
      UPDATE payments
      SET status = 'Completed',
          method = $1,
          reference_no = $2,
          payment_date = NOW()
      WHERE payment_id = $3
    `, [
      checkoutSession.attributes.payment_method_used || 'paymongo',
      checkoutSession.id,
      payment_id
    ]);
    
    // 3. Update payment transaction
    await client.query(`
      UPDATE payment_transactions
      SET status = 'paid',
          paymongo_status = $1,
          paid_at = NOW(),
          webhook_data = $2
      WHERE payment_id = $3
    `, [
      checkoutSession.attributes.status,
      JSON.stringify(event.data),
      payment_id
    ]);
    
    // 4. Process based on payment type
    if (payment_type === 'enrollment') {
      // Mark enrollment fees as paid
      await client.query(`
        UPDATE enrollment_fees
        SET is_paid = true
        WHERE enrollment_id = $1
      `, [enrollment_id]);
      
      // Update enrollment status to 'Enrolled'
      await client.query(`
        UPDATE enrollments
        SET status = 'Enrolled'
        WHERE enrollment_id = $1
      `, [enrollment_id]);
      
      // Add to account balance (if partial payment or installment)
      const new_balance = current_balance + amount;
      await client.query(`
        UPDATE accounts
        SET total_balance = $1,
            last_updated = NOW()
        WHERE account_id = $2
      `, [new_balance, payment.account_id]);
      
      // Log transaction
      await client.query(`
        INSERT INTO account_transactions (
          account_id,
          payment_id,
          transaction_type,
          amount,
          balance_before,
          balance_after,
          description
        )
        VALUES ($1, $2, 'payment', $3, $4, $5, $6)
      `, [
        payment.account_id,
        payment_id,
        amount,
        current_balance,
        new_balance,
        `Enrollment payment for Enrollment ID: ${enrollment_id}`
      ]);
      
    } else if (payment_type === 'balance') {
      // Reduce outstanding balance
      const new_balance = current_balance - amount;
      await client.query(`
        UPDATE accounts
        SET total_balance = $1,
            last_updated = NOW()
        WHERE account_id = $2
      `, [new_balance, payment.account_id]);
      
      // Log transaction
      await client.query(`
        INSERT INTO account_transactions (
          account_id,
          payment_id,
          transaction_type,
          amount,
          balance_before,
          balance_after,
          description
        )
        VALUES ($1, $2, 'payment', $3, $4, $5, $6)
      `, [
        payment.account_id,
        payment_id,
        amount,
        current_balance,
        new_balance,
        `Outstanding balance payment for Student ID: ${payment.student_id}`
      ]);
    }
    
    await client.query('COMMIT');
    console.log(`Payment ${payment_id} processed successfully`);
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Payment processing error:', error);
    throw error;
  }
}

async function handlePaymentFailed(event, client) {
  try {
    const paymentIntent = event.data.attributes.data;
    const metadata = paymentIntent.attributes.metadata;
    
    if (metadata && metadata.payment_id) {
      await client.query(`
        UPDATE payments
        SET status = 'Failed'
        WHERE payment_id = $1
      `, [parseInt(metadata.payment_id)]);
      
      await client.query(`
        UPDATE payment_transactions
        SET status = 'failed',
            paymongo_status = $1
        WHERE payment_id = $2
      `, [paymentIntent.attributes.status, parseInt(metadata.payment_id)]);
    }
  } catch (error) {
    console.error('Failed payment handling error:', error);
  }
}

module.exports = router;