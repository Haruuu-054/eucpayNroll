const express = require('express');
// ✅ ADD THIS IMPORT AT THE TOP
const { handleEnrollmentPayment } = require('./billing');

function createPaymentsRouter(supabase, logger) {
  const router = express.Router();

  // ============================================
  // PAYMENT CONFIGURATION
  // ============================================
  const PAYMONGO_ENABLED = process.env.PAYMONGO_SECRET_KEY && 
                           process.env.PAYMONGO_PUBLIC_KEY !== 'offline';
  
  let paymongoClient = null;
  
  if (PAYMONGO_ENABLED) {
    const axios = require('axios');
    paymongoClient = axios.create({
      baseURL: 'https://api.paymongo.com/v1',
      headers: {
        'Authorization': `Basic ${Buffer.from(process.env.PAYMONGO_SECRET_KEY + ':').toString('base64')}`,
        'Content-Type': 'application/json'
      }
    });
  }

  // ============================================
  // GET STUDENT BALANCE
  // ============================================
  router.get('/balance/:student_id', async (req, res) => {
    try {
      const { student_id } = req.params;
      
      logger.info('Fetching balance for student', { student_id });

      // Get account balance
      const { data: accountData, error: accountError } = await supabase
        .from('accounts')
        .select('account_id, student_id, total_balance, last_updated')
        .eq('student_id', student_id)
        .maybeSingle();

      if (accountError) {
        logger.error('Error fetching account', { error: accountError.message });
        return res.status(400).json({ error: accountError.message });
      }

      // Get student info if account exists
      let studentInfo = null;
      if (accountData) {
        const { data: student, error: studentError } = await supabase
          .from('students')
          .select('first_name, last_name, email')
          .eq('student_id', student_id)
          .maybeSingle();

        if (!studentError && student) {
          studentInfo = student;
        }
      }

      if (!accountData) {
        return res.json({
          success: true,
          has_balance: false,
          balance: 0,
          pending_installments: [],
          recent_payments: []
        });
      }

      const balance = parseFloat(accountData.total_balance || 0);

      // Get pending installments
      const { data: enrollments, error: enrollmentsError } = await supabase
        .from('enrollments')
        .select('enrollment_id')
        .eq('student_id', student_id);

      let installments = [];
      if (!enrollmentsError && enrollments && enrollments.length > 0) {
        const enrollmentIds = enrollments.map(e => e.enrollment_id);
        
        const { data: installmentsData, error: installmentsError } = await supabase
          .from('payment_installments')
          .select(`
            installment_id,
            installment_number,
            amount,
            due_date,
            status,
            enrollment_id,
            enrollments:enrollment_id (
              enrollment_id,
              semesters:semester_id (
                school_year
              )
            )
          `)
          .in('enrollment_id', enrollmentIds)
          .eq('status', 'pending')
          .order('due_date', { ascending: true });

        if (!installmentsError) {
          installments = installmentsData || [];
        } else {
          logger.warn('Error fetching installments', { error: installmentsError.message });
        }
      }

      // Get recent payments
      const { data: payments, error: paymentsError } = await supabase
        .from('payments')
        .select('payment_id, amount, payment_date, payment_type, status, reference_no, method')
        .eq('account_id', accountData.account_id)
        .order('payment_date', { ascending: false })
        .limit(5);

      if (paymentsError) {
        logger.warn('Error fetching payments', { error: paymentsError.message });
      }

      res.json({
        success: true,
        has_balance: balance > 0,
        balance: balance,
        account_id: accountData.account_id,
        student_name: studentInfo ? `${studentInfo.first_name} ${studentInfo.last_name}` : null,
        email: studentInfo?.email || null,
        last_updated: accountData.last_updated,
        pending_installments: installments,
        recent_payments: payments || []
      });

    } catch (err) {
      logger.error('Unexpected error fetching balance', { error: err.message, stack: err.stack });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ============================================
  // CREATE PAYMENT CHECKOUT
  // ============================================
  router.post('/create-checkout', async (req, res) => {
    try {
      const { 
        enrollment_id, 
        student_id, 
        payment_type = 'enrollment',
        custom_amount,
        created_by // User ID who initiated the payment (from auth/session)
      } = req.body;

      if (!student_id) {
        return res.status(400).json({ 
          error: 'Student ID is required' 
        });
      }

      logger.info('Creating payment checkout', { 
        student_id, 
        payment_type,
        paymongo_enabled: PAYMONGO_ENABLED 
      });

      // 1. Get or create student account
      let { data: account, error: accountError } = await supabase
        .from('accounts')
        .select('account_id, total_balance')
        .eq('student_id', student_id)
        .maybeSingle();

      if (accountError) {
        logger.error('Error fetching account', { error: accountError.message });
        return res.status(400).json({ error: accountError.message });
      }

      let account_id;
      let current_balance = 0;

      if (!account) {
        const { data: newAccount, error: createError } = await supabase
          .from('accounts')
          .insert([{ student_id, total_balance: 0 }])
          .select()
          .single();

        if (createError) {
          logger.error('Error creating account', { error: createError.message });
          return res.status(400).json({ error: createError.message });
        }

        account_id = newAccount.account_id;
      } else {
        account_id = account.account_id;
        current_balance = parseFloat(account.total_balance);
      }

      // 2. Get semester_id from enrollment if available
      let for_semester_id = null;
      if (enrollment_id) {
        const { data: enrollment, error: enrollmentError } = await supabase
          .from('enrollments')
          .select('semester_id')
          .eq('enrollment_id', enrollment_id)
          .maybeSingle();

        if (!enrollmentError && enrollment) {
          for_semester_id = enrollment.semester_id;
        }
      } else if (payment_type === 'balance') {
        // For balance payments without enrollment_id, try to get most recent enrollment
        const { data: recentEnrollment } = await supabase
          .from('enrollments')
          .select('enrollment_id, semester_id')
          .eq('student_id', student_id)
          .order('payment_date', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (recentEnrollment) {
          for_semester_id = recentEnrollment.semester_id;
          // Optionally set enrollment_id for the payment
          // enrollment_id = recentEnrollment.enrollment_id;
        }
      }

      // 3. Calculate amount to pay
      let amount;
      let description;

      if (payment_type === 'enrollment') {
        if (!enrollment_id) {
          return res.status(400).json({ 
            error: 'Enrollment ID is required for enrollment payments' 
          });
        }

        const { data: fees, error: feesError } = await supabase
          .from('enrollment_fees')
          .select('amount')
          .eq('enrollment_id', enrollment_id)
          .eq('is_paid', false);

        if (feesError) {
          logger.error('Error fetching fees', { error: feesError.message });
          return res.status(400).json({ error: feesError.message });
        }

        amount = fees.reduce((sum, fee) => sum + parseFloat(fee.amount), 0);
        description = `Enrollment Payment - Enrollment ID: ${enrollment_id}`;

      } else if (payment_type === 'balance') {
        if (current_balance <= 0) {
          return res.status(400).json({ 
            error: 'No outstanding balance to pay' 
          });
        }

        if (custom_amount && parseFloat(custom_amount) > 0) {
          amount = Math.min(parseFloat(custom_amount), current_balance);
          description = `Partial Balance Payment - Student ID: ${student_id}`;
        } else {
          amount = current_balance;
          description = `Full Balance Payment - Student ID: ${student_id}`;
        }

      } else if (payment_type === 'monthly') {
        if (!enrollment_id) {
          return res.status(400).json({ 
            error: 'Enrollment ID is required for monthly payments' 
          });
        }

        const { data: installment, error: installmentError } = await supabase
          .from('payment_installments')
          .select('installment_id, amount')
          .eq('enrollment_id', enrollment_id)
          .eq('status', 'pending')
          .order('due_date', { ascending: true })
          .limit(1)
          .maybeSingle();

        if (installmentError || !installment) {
          return res.status(400).json({ 
            error: 'No pending installments found' 
          });
        }

        amount = parseFloat(installment.amount);
        description = `Monthly Installment Payment - Enrollment ID: ${enrollment_id}`;
      }

      if (!amount || amount <= 0) {
        return res.status(400).json({ 
          error: 'Invalid payment amount' 
        });
      }

      // 4. Create payment record WITH ALL COLUMNS
      const { data: payment, error: paymentError } = await supabase
        .from('payments')
        .insert([{
          account_id,
          enrollment_id: enrollment_id || null, // Can be null for balance payments
          amount,
          status: 'Pending',
          payment_type,
          for_semester_id,  // ✅ NEW: Link to semester
          created_by,       // ✅ NEW: User who created the payment
          payment_date: new Date().toISOString()
        }])
        .select()
        .single();

      if (paymentError) {
        logger.error('Error creating payment', { error: paymentError.message });
        return res.status(400).json({ error: paymentError.message });
      }

      const payment_id = payment.payment_id;

      // 5. Create PayMongo checkout OR mock checkout for offline testing
      let checkout_url;
      let checkout_id;

      if (PAYMONGO_ENABLED) {
        // ONLINE MODE: Use real PayMongo
        try {
          const amountInCentavos = Math.round(amount * 100);

          const checkoutData = {
            data: {
              attributes: {
                amount: amountInCentavos,
                currency: 'PHP',
                description: description,
                line_items: [{
                  name: description,
                  amount: amountInCentavos,
                  currency: 'PHP',
                  quantity: 1
                }],
                payment_method_types: ['gcash', 'paymaya', 'card', 'grab_pay'],
                success_url: `${process.env.BASE_URL}/payment/success?payment_id=${payment_id}`,
                cancel_url: `${process.env.BASE_URL}/payment/cancel?payment_id=${payment_id}`,
                metadata: {
                  payment_id: payment_id.toString(),
                  enrollment_id: enrollment_id?.toString() || '',
                  student_id: student_id.toString(),
                  payment_type: payment_type,
                  payment_category: 'tuition', // ✅ Identifies as tuition payment
                  account_id: account_id.toString()
                }
              }
            }
          };

          const checkoutResponse = await paymongoClient.post('/checkout_sessions', checkoutData);
          const checkoutSession = checkoutResponse.data.data;

          checkout_url = checkoutSession.attributes.checkout_url;
          checkout_id = checkoutSession.id;

          // Save PayMongo transaction
          await supabase.from('payment_transactions').insert([{
            payment_id,
            paymongo_payment_id: checkout_id,
            amount,
            currency: 'PHP',
            status: 'pending',
            checkout_url,
            expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
          }]);

        } catch (error) {
          logger.error('PayMongo error', { 
            error: error.response?.data || error.message 
          });
          return res.status(500).json({ 
            error: 'Payment gateway error',
            details: error.response?.data?.errors?.[0]?.detail || error.message
          });
        }

      } else {
        // OFFLINE MODE: Mock checkout for local testing
        checkout_url = `${process.env.BASE_URL || 'http://localhost:3000'}/payment/mock-checkout?payment_id=${payment_id}`;
        checkout_id = `mock_checkout_${payment_id}_${Date.now()}`;

        // Save mock transaction
        await supabase.from('payment_transactions').insert([{
          payment_id,
          paymongo_payment_id: checkout_id,
          amount,
          currency: 'PHP',
          status: 'pending',
          checkout_url,
          expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
        }]);

        logger.info('Created OFFLINE mock checkout', { payment_id, checkout_id });
      }

      res.json({
        success: true,
        payment_id,
        checkout_url,
        checkout_id,
        amount,
        payment_type,
        description,
        is_mock: !PAYMONGO_ENABLED,
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000)
      });

    } catch (err) {
      logger.error('Unexpected error creating checkout', { error: err.message, stack: err.stack });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ============================================
  // MOCK PAYMENT COMPLETION (FOR OFFLINE TESTING)
  // ============================================
  router.post('/mock-complete/:payment_id', async (req, res) => {
    if (PAYMONGO_ENABLED) {
      return res.status(403).json({ 
        error: 'Mock payments not allowed in production mode' 
      });
    }

    try {
      const { payment_id } = req.params;
      const { 
        success = true,
        payment_method = 'mock_payment',
        completed_by // User who completed/verified the payment
      } = req.body;

      logger.info('Mock payment completion', { payment_id, success });

      // Get payment details
      const { data: payment, error: paymentError } = await supabase
        .from('payments')
        .select(`
          *,
          accounts:account_id (
            account_id,
            total_balance,
            student_id
          )
        `)
        .eq('payment_id', payment_id)
        .single();

      if (paymentError || !payment) {
        return res.status(404).json({ error: 'Payment not found' });
      }

      if (success) {
        // Simulate successful payment
        const amount = parseFloat(payment.amount);
        const previous_balance = parseFloat(payment.accounts.total_balance);

        // Update payment status WITH METHOD
        await supabase
          .from('payments')
          .update({
            status: 'Completed',
            payment_date: new Date().toISOString(),
            reference_no: `MOCK_${payment_id}_${Date.now()}`,
            method: payment_method // ✅ NEW: Set payment method
          })
          .eq('payment_id', payment_id);

        // Update transaction
        await supabase
          .from('payment_transactions')
          .update({
            status: 'paid',
            paid_at: new Date().toISOString(),
            payment_method: payment_method
          })
          .eq('payment_id', payment_id);

        // Process based on payment type
        if (payment.payment_type === 'enrollment') {
          await supabase
            .from('enrollment_fees')
            .update({
              is_paid: true,
              paid_at: new Date().toISOString()
            })
            .eq('enrollment_id', payment.enrollment_id)
            .eq('is_paid', false);

        } else if (payment.payment_type === 'balance' || payment.payment_type === 'monthly') {
          const new_balance = Math.max(0, previous_balance - amount);

          await supabase
            .from('accounts')
            .update({
              total_balance: new_balance,
              last_updated: new Date().toISOString()
            })
            .eq('account_id', payment.accounts.account_id);

          if (payment.payment_type === 'monthly' && payment.enrollment_id) {
            await supabase
              .from('payment_installments')
              .update({
                status: 'paid',
                paid_at: new Date().toISOString(),
                payment_id: payment_id
              })
              .eq('enrollment_id', payment.enrollment_id)
              .eq('status', 'pending')
              .order('due_date', { ascending: true })
              .limit(1);
          }
        }

        // Create transaction log WITH CREATED_BY
        await supabase.from('account_transactions').insert([{
          account_id: payment.accounts.account_id,
          payment_id: payment_id,
          transaction_type: 'payment',
          amount,
          balance_before: previous_balance,
          balance_after: Math.max(0, previous_balance - amount),
          description: `Mock Payment - ${payment.payment_type} via ${payment_method}`,
          created_by: completed_by || payment.created_by, // ✅ NEW: Track who completed
          payment_date: new Date().toISOString()
        }]);

        res.json({ 
          success: true, 
          message: 'Mock payment completed successfully',
          payment_id,
          new_balance: Math.max(0, previous_balance - amount),
          payment_method
        });

      } else {
        // Simulate failed payment
        await supabase
          .from('payments')
          .update({ 
            status: 'Failed',
            method: payment_method // ✅ Still record the attempted method
          })
          .eq('payment_id', payment_id);

        await supabase
          .from('payment_transactions')
          .update({ 
            status: 'failed',
            payment_method: payment_method
          })
          .eq('payment_id', payment_id);

        res.json({ 
          success: false, 
          message: 'Mock payment failed' 
        });
      }

    } catch (err) {
      logger.error('Error in mock payment completion', { error: err.message, stack: err.stack });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ============================================
  // PAYMONGO WEBHOOK HANDLER (MODIFIED)
  // ============================================
  router.post('/webhook', async (req, res) => {
    try {
      const event = req.body;
      
      logger.info('PayMongo webhook received', { 
        type: event.data?.attributes?.type 
      });

      // Verify webhook signature (recommended in production)
      // const signature = req.headers['paymongo-signature'];
      // if (!verifyWebhookSignature(signature, req.body)) {
      //   return res.status(401).json({ error: 'Invalid signature' });
      // }

      const eventType = event.data?.attributes?.type;
      const eventData = event.data?.attributes?.data;

      if (eventType === 'checkout_session.payment.paid') {
        const checkoutSession = eventData;
        const metadata = checkoutSession.attributes?.metadata;
        const payment_id = metadata?.payment_id;
        const payment_method = checkoutSession.attributes?.payments?.[0]?.attributes?.source?.type || 'card';

        if (!payment_id) {
          logger.error('No payment_id in webhook metadata');
          return res.status(400).json({ error: 'Missing payment_id' });
        }

        // ============================================
        // ✅ ADD THIS ROUTING LOGIC HERE
        // ============================================
        
        // Check if this is an enrollment payment
        if (metadata.enrollment_id && metadata.payment_category === 'enrollment') {
          logger.info('🎓 ENROLLMENT payment detected', { 
            payment_id,
            enrollment_id: metadata.enrollment_id 
          });
          
          // Route to enrollment payment handler
          await handleEnrollmentPayment(metadata, supabase, logger);
          
          return res.json({ received: true, type: 'enrollment' });
        }
        
        // ============================================
        // YOUR EXISTING TUITION PAYMENT LOGIC BELOW
        // ============================================
        
        logger.info('💰 TUITION payment - using existing logic', { 
          payment_id 
        });

        // Get payment details
        const { data: payment, error: paymentError } = await supabase
          .from('payments')
          .select(`
            *,
            accounts:account_id (
              account_id,
              total_balance,
              student_id
            )
          `)
          .eq('payment_id', payment_id)
          .single();

        if (paymentError || !payment) {
          logger.error('Payment not found', { payment_id });
          return res.status(404).json({ error: 'Payment not found' });
        }

        const amount = parseFloat(payment.amount);
        const previous_balance = parseFloat(payment.accounts.total_balance);

        // Update payment status
        await supabase
          .from('payments')
          .update({
            status: 'Completed',
            payment_date: new Date().toISOString(),
            reference_no: checkoutSession.id,
            method: payment_method // ✅ Set payment method from PayMongo
          })
          .eq('payment_id', payment_id);

        // Update transaction
        await supabase
          .from('payment_transactions')
          .update({
            status: 'paid',
            paid_at: new Date().toISOString(),
            payment_method: payment_method,
            paymongo_status: checkoutSession.attributes?.payment_intent?.attributes?.status,
            webhook_data: checkoutSession
          })
          .eq('payment_id', payment_id);

        // Process based on payment type
        if (payment.payment_type === 'enrollment') {
          await supabase
            .from('enrollment_fees')
            .update({
              is_paid: true,
              paid_at: new Date().toISOString()
            })
            .eq('enrollment_id', payment.enrollment_id)
            .eq('is_paid', false);

        } else if (payment.payment_type === 'balance' || payment.payment_type === 'monthly') {
          const new_balance = Math.max(0, previous_balance - amount);

          await supabase
            .from('accounts')
            .update({
              total_balance: new_balance,
              last_updated: new Date().toISOString()
            })
            .eq('account_id', payment.accounts.account_id);

          if (payment.payment_type === 'monthly' && payment.enrollment_id) {
            await supabase
              .from('payment_installments')
              .update({
                status: 'paid',
                paid_at: new Date().toISOString(),
                payment_id: payment_id
              })
              .eq('enrollment_id', payment.enrollment_id)
              .eq('status', 'pending')
              .order('due_date', { ascending: true })
              .limit(1);
          }
        }

        // Create transaction log
        await supabase.from('account_transactions').insert([{
          account_id: payment.accounts.account_id,
          payment_id: payment_id,
          transaction_type: 'payment',
          amount,
          balance_before: previous_balance,
          balance_after: Math.max(0, previous_balance - amount),
          description: `Payment via ${payment_method} - ${payment.payment_type}`,
          created_by: payment.created_by, // System/original creator
          payment_date: new Date().toISOString()
        }]);

        logger.info('Payment completed via webhook', { 
          payment_id, 
          payment_method,
          amount 
        });

        res.json({ success: true, message: 'Webhook processed' });

      } else {
        logger.info('Unhandled webhook event', { eventType });
        res.json({ success: true, message: 'Event noted' });
      }

    } catch (err) {
      logger.error('Webhook processing error', { error: err.message, stack: err.stack });
      res.status(500).json({ error: 'Webhook processing failed' });
    }
  });

  // ============================================
  // GET PAYMENT HISTORY
  // ============================================
  router.get('/history/:student_id', async (req, res) => {
    try {
      const { student_id } = req.params;
      const { limit = 20, offset = 0 } = req.query;

      logger.info('Fetching payment history', { student_id });

      // Get account
      const { data: account, error: accountError } = await supabase
        .from('accounts')
        .select('account_id')
        .eq('student_id', student_id)
        .maybeSingle();

      if (accountError) {
        return res.status(400).json({ error: accountError.message });
      }

      if (!account) {
        return res.json({
          success: true,
          payments: [],
          total: 0,
          limit: parseInt(limit),
          offset: parseInt(offset)
        });
      }

      // Get payments with transactions
      const { data: payments, error: paymentsError } = await supabase
        .from('payments')
        .select(`
          payment_id,
          amount,
          payment_date,
          payment_type,
          status,
          reference_no,
          method,
          for_semester_id,
          payment_transactions (
            payment_method,
            paymongo_payment_id
          ),
          account_transactions (
            description
          ),
          semesters:for_semester_id (
            semester_name,
            school_year
          )
        `)
        .eq('account_id', account.account_id)
        .order('payment_date', { ascending: false })
        .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

      if (paymentsError) {
        return res.status(400).json({ error: paymentsError.message });
      }

      // Get total count
      const { count, error: countError } = await supabase
        .from('payments')
        .select('*', { count: 'exact', head: true })
        .eq('account_id', account.account_id);

      if (countError) {
        logger.warn('Error counting payments', { error: countError.message });
      }

      res.json({
        success: true,
        payments: payments || [],
        total: count || 0,
        limit: parseInt(limit),
        offset: parseInt(offset)
      });

    } catch (err) {
      logger.error('Error fetching payment history', { error: err.message, stack: err.stack });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ============================================
  // GET PAYMENT STATUS
  // ============================================
  router.get('/status/:payment_id', async (req, res) => {
    try {
      const { payment_id } = req.params;

      const { data: payment, error } = await supabase
        .from('payments')
        .select(`
          *,
          payment_transactions (
            paymongo_payment_id,
            status,
            payment_method,
            checkout_url,
            paid_at
          ),
          semesters:for_semester_id (
            semester_name,
            school_year
          )
        `)
        .eq('payment_id', payment_id)
        .single();

      if (error || !payment) {
        return res.status(404).json({ error: 'Payment not found' });
      }

      res.json({
        success: true,
        payment
      });

    } catch (err) {
      logger.error('Error fetching payment status', { error: err.message, stack: err.stack });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ============================================
  // CANCEL PAYMENT
  // ============================================
  router.post('/cancel/:payment_id', async (req, res) => {
    try {
      const { payment_id } = req.params;

      const { data: payment, error: fetchError } = await supabase
        .from('payments')
        .select('status')
        .eq('payment_id', payment_id)
        .single();

      if (fetchError || !payment) {
        return res.status(404).json({ error: 'Payment not found' });
      }

      if (payment.status !== 'Pending') {
        return res.status(400).json({
          error: `Cannot cancel payment with status: ${payment.status}`
        });
      }

      await supabase
        .from('payments')
        .update({ status: 'Cancelled' })
        .eq('payment_id', payment_id);

      await supabase
        .from('payment_transactions')
        .update({ status: 'cancelled' })
        .eq('payment_id', payment_id);

      res.json({
        success: true,
        message: 'Payment cancelled successfully'
      });

    } catch (err) {
      logger.error('Error cancelling payment', { error: err.message, stack: err.stack });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = createPaymentsRouter;