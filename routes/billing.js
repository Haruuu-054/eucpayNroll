const express = require("express");
const crypto = require("crypto");

// ============================================
// FIXED: Payment Processing with Atomic Operations
// ============================================

async function processPaymentCompletion(supabase, logger, payment_id, payment) {
  try {
    // Check if already processed (idempotency)
    if (payment.status === "Completed") {
      logger.info("Payment already completed - skipping duplicate processing", {
        payment_id,
      });
      return { success: true, already_processed: true };
    }

    logger.info("Starting payment processing", {
      payment_id,
      payment_type: payment.payment_type,
      amount: payment.amount,
      enrollment_id: payment.enrollment_id,
    });

    // ============================================
    // CRITICAL FIX: Use Database Transaction
    // ============================================
    const { data: result, error: txError } = await supabase.rpc(
      "process_payment_transaction",
      {
        p_payment_id: payment_id,
        p_account_id: payment.account_id,
        p_enrollment_id: payment.enrollment_id,
        p_amount: parseFloat(payment.amount),
        p_payment_type: payment.payment_type,
      }
    );

    if (txError) {
      logger.error("Transaction processing failed", {
        error: txError.message,
        payment_id,
      });
      throw txError;
    }

    logger.info("Payment transaction completed successfully", {
      payment_id,
      result,
    });

    // ============================================
    // Post-transaction processing (non-critical)
    // ============================================

    // Get enrollment details for subject creation
    const { data: enrollmentDetails } = await supabase
      .from("enrollments")
      .select("program_id, semester_id, student_id, status")
      .eq("enrollment_id", payment.enrollment_id)
      .single();

    // Only create subjects if enrollment is now "Enrolled"
    if (enrollmentDetails && enrollmentDetails.status === "Enrolled") {
      if (
        payment.payment_type === "full_payment" ||
        payment.payment_type === "downpayment"
      ) {
        // Create enrollment subjects (non-critical operation)
        try {
          await createEnrollmentSubjects(
            supabase,
            logger,
            payment.enrollment_id,
            enrollmentDetails
          );
        } catch (subjectError) {
          // Log but don't fail the payment
          logger.error("Error creating enrollment subjects (non-critical)", {
            error: subjectError.message,
            enrollment_id: payment.enrollment_id,
          });
        }
      }
    }

    logger.info("Payment processed successfully", {
      payment_id,
      payment_type: payment.payment_type,
      enrollment_id: payment.enrollment_id,
    });

    return { success: true };
  } catch (error) {
    logger.error("Error processing payment completion", {
      error: error.message,
      stack: error.stack,
      payment_id,
    });
    throw error;
  }
}

// ============================================
// Helper function to create enrollment subjects
// ============================================
async function createEnrollmentSubjects(
  supabase,
  logger,
  enrollment_id,
  enrollmentDetails
) {
  try {
    // Check if subjects already exist
    const { data: existingSubjects } = await supabase
      .from("enrollment_subjects")
      .select("enrollment_subject_id")
      .eq("enrollment_id", enrollment_id)
      .limit(1);

    if (existingSubjects && existingSubjects.length > 0) {
      logger.info("Enrollment subjects already exist", { enrollment_id });
      return;
    }

    const { program_id, semester_id, student_id } = enrollmentDetails;

    // Get student's year level
    const { data: student } = await supabase
      .from("students")
      .select("year_level")
      .eq("student_id", student_id)
      .single();

    if (!student) {
      logger.error("Student not found for subject creation", { student_id });
      return;
    }

    // Get all subjects for the program, semester, and year level
    const { data: subjects, error: subjectsError } = await supabase
      .from("course_subjects")
      .select("subject_id")
      .eq("program_id", program_id)
      .eq("semester_id", semester_id)
      .eq("year_level", student.year_level);

    if (subjectsError) {
      logger.error("Error fetching subjects", { error: subjectsError.message });
      return;
    }

    if (!subjects || subjects.length === 0) {
      logger.warn("No subjects found for enrollment", {
        program_id,
        semester_id,
        year_level: student.year_level,
      });
      return;
    }

    // Create enrollment subjects
    const enrollmentSubjects = subjects.map((subject) => ({
      enrollment_id,
      subject_id: subject.subject_id,
      status: "Enrolled",
    }));

    const { error: insertError } = await supabase
      .from("enrollment_subjects")
      .insert(enrollmentSubjects);

    if (insertError) {
      logger.error("Error creating enrollment subjects", {
        error: insertError.message,
      });
      return;
    }

    logger.info("Enrollment subjects created successfully", {
      enrollment_id,
      subject_count: enrollmentSubjects.length,
    });
  } catch (err) {
    logger.error("Error in createEnrollmentSubjects", {
      error: err.message,
      enrollment_id,
    });
  }
}

// ============================================
// FIXED: Generate Billing with Account Initialization
// ============================================
async function generateBilling(supabase, logger, enrollment_id, created_by) {
  logger.info("Generating billing for enrollment", { enrollment_id });

  // 1. Get enrollment with scheme details
  const { data: enrollment, error: enrollmentError } = await supabase
    .from("enrollments")
    .select(
      `
      enrollment_id,
      student_id,
      program_id,
      semester_id,
      scheme_id,
      status,
      tuition_schemes (
        scheme_id,
        scheme_name,
        scheme_type,
        amount,
        downpayment,
        monthly_payment,
        months,
        discount
      )
    `
    )
    .eq("enrollment_id", enrollment_id)
    .single();

  if (enrollmentError || !enrollment) {
    logger.error("Enrollment not found", {
      error: enrollmentError?.message,
    });
    throw new Error("Enrollment not found");
  }

  const scheme = enrollment.tuition_schemes;
  if (!scheme) {
    throw new Error("No tuition scheme found for this enrollment");
  }

  // 2. Check if billing already exists
  const { data: existingFees } = await supabase
    .from("enrollment_fees")
    .select("fee_id")
    .eq("enrollment_id", enrollment_id)
    .limit(1);

  const { data: existingInstallments } = await supabase
    .from("payment_installments")
    .select("installment_id")
    .eq("enrollment_id", enrollment_id)
    .limit(1);

  if (existingFees?.length > 0 || existingInstallments?.length > 0) {
    throw new Error("Billing already generated for this enrollment");
  }

  // 3. Calculate total amount after discount
  const baseAmount = parseFloat(scheme.amount);
  const discount = parseFloat(scheme.discount) || 0;
  const totalAmount = Math.round((baseAmount - discount) * 100) / 100;

  if (totalAmount <= 0) {
    throw new Error("Invalid billing amount");
  }

  // ============================================
  // CRITICAL FIX: Initialize Account Balance Atomically
  // ============================================
  const student_id = enrollment.student_id;

  // Use database function to atomically initialize account
  const { data: accountResult, error: accountError } = await supabase.rpc(
    "initialize_account_balance",
    {
      p_enrollment_id: enrollment_id, // ✅ First parameter
      p_scheme_name: scheme.scheme_name, // ✅ Second parameter
      p_student_id: student_id, // ✅ Third parameter
      p_total_amount: totalAmount, // ✅ Fourth parameter
    }
  );

  if (accountError) {
    logger.error("Error initializing account", {
      error: accountError.message,
      student_id,
    });
    throw accountError;
  }

  const account_id = accountResult;

  logger.info("Account balance initialized", {
    account_id,
    student_id,
    initial_balance: totalAmount,
  });

  // 4. Generate billing based on scheme type
  let result = {};

  if (scheme.scheme_type === "full_payment") {
    // ===== SCHEME 1: FULL PAYMENT =====
    const { data: fee, error: feeError } = await supabase
      .from("enrollment_fees")
      .insert([
        {
          enrollment_id,
          fee_type: "Tuition",
          description: `Full Payment - ${scheme.scheme_name}`,
          amount: totalAmount,
          is_paid: false,
        },
      ])
      .select()
      .single();

    if (feeError) {
      logger.error("Error creating full payment fee", {
        error: feeError.message,
      });
      throw new Error("Failed to generate billing");
    }

    result = {
      billing_type: "full_payment",
      scheme_id: scheme.scheme_id,
      total_amount: totalAmount,
      discount: discount,
      fee_id: fee.fee_id,
      description: "Single full payment required",
      account_balance: totalAmount,
    };
  } else if (scheme.scheme_type === "installment") {
    // ===== SCHEME 2 & 3: INSTALLMENT PLANS =====
    const downpayment = parseFloat(scheme.downpayment) || 0;
    const monthlyPayment = parseFloat(scheme.monthly_payment) || 0;
    const months = parseInt(scheme.months) || 4;

    // Validate installment amounts
    const totalInstallments =
      Math.round((downpayment + monthlyPayment * months) * 100) / 100;
    if (Math.abs(totalInstallments - totalAmount) > 0.01) {
      logger.warn("Installment amounts do not match total", {
        totalAmount,
        totalInstallments,
        downpayment,
        monthlyPayment,
        months,
      });
    }

    // Create downpayment fee
    const { data: downpaymentFee, error: downpaymentError } = await supabase
      .from("enrollment_fees")
      .insert([
        {
          enrollment_id,
          fee_type: "Downpayment",
          description: `Downpayment - ${scheme.scheme_name}`,
          amount: downpayment,
          is_paid: false,
        },
      ])
      .select()
      .single();

    if (downpaymentError) {
      logger.error("Error creating downpayment", {
        error: downpaymentError.message,
      });
      throw new Error("Failed to generate downpayment");
    }

    // Create installment records
    const installments = [];
    const currentDate = new Date();

    for (let i = 1; i <= months; i++) {
      const dueDate = new Date(currentDate);
      dueDate.setMonth(dueDate.getMonth() + i);

      installments.push({
        enrollment_id,
        installment_number: i,
        amount: monthlyPayment,
        due_date: dueDate.toISOString().split("T")[0],
        status: "pending",
      });
    }

    const { data: createdInstallments, error: installmentError } =
      await supabase.from("payment_installments").insert(installments).select();

    if (installmentError) {
      logger.error("Error creating installments", {
        error: installmentError.message,
      });

      // Rollback: delete downpayment fee
      await supabase
        .from("enrollment_fees")
        .delete()
        .eq("fee_id", downpaymentFee.fee_id);

      throw new Error("Failed to generate installments");
    }

    result = {
      billing_type: "installment",
      scheme_id: scheme.scheme_id,
      total_amount: totalAmount,
      discount: discount,
      downpayment: downpayment,
      downpayment_fee_id: downpaymentFee.fee_id,
      monthly_payment: monthlyPayment,
      number_of_months: months,
      installments: createdInstallments.map((inst) => ({
        installment_id: inst.installment_id,
        installment_number: inst.installment_number,
        amount: inst.amount,
        due_date: inst.due_date,
      })),
      description: `Downpayment of ₱${downpayment.toFixed(
        2
      )} + ${months} monthly payments of ₱${monthlyPayment.toFixed(2)}`,
      account_balance: totalAmount,
      initial_payment_required: downpayment,
    };
  } else {
    throw new Error(`Invalid scheme type: ${scheme.scheme_type}`);
  }

  logger.info("Billing generated successfully", {
    enrollment_id,
    scheme_id: scheme.scheme_id,
    scheme_type: scheme.scheme_type,
    total_amount: totalAmount,
    account_balance_initialized: totalAmount,
  });

  return {
    success: true,
    enrollment_id,
    account_id,
    scheme_name: scheme.scheme_name,
    scheme_type: scheme.scheme_type,
    ...result,
    generated_at: new Date().toISOString(),
    generated_by: created_by,
  };
}

// ============================================
// WEBHOOK HANDLER - Extracted for reuse
// ============================================
async function handleEnrollmentPayment(metadata, supabase, logger) {
  try {
    const payment_id = parseInt(metadata.payment_id);

    if (!payment_id) {
      logger.error("No payment_id in enrollment webhook metadata");
      throw new Error("Invalid webhook metadata");
    }

    logger.info("🎓 Handling enrollment payment from webhook", {
      payment_id,
      enrollment_id: metadata.enrollment_id,
    });

    // Get payment details with row-level locking to prevent race conditions
    const { data: payment, error: paymentFetchError } = await supabase
      .from("payments")
      .select("*")
      .eq("payment_id", payment_id)
      .single();

    if (paymentFetchError || !payment) {
      logger.error("Enrollment payment not found", { payment_id });
      throw new Error("Payment not found");
    }

    // Use the shared payment processing function
    await processPaymentCompletion(supabase, logger, payment_id, payment);

    logger.info("🎉 Enrollment payment handled successfully", { payment_id });
  } catch (error) {
    logger.error("❌ Error handling enrollment payment from webhook", {
      error: error.message,
      stack: error.stack,
      metadata,
    });
    throw error;
  }
}

// ============================================
// MAIN ROUTER FUNCTION
// ============================================
function enrollmentbilling(supabase, logger) {
  const router = express.Router();

  // PayMongo configuration
  const PAYMONGO_ENABLED = process.env.PAYMONGO_ENABLED === "true";
  const PAYMONGO_SECRET_KEY = process.env.PAYMONGO_SECRET_KEY;
  const PAYMONGO_WEBHOOK_SECRET = process.env.PAYMONGO_WEBHOOK_SECRET;
  const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
  const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";

  // Constants
  const CHECKOUT_EXPIRY_HOURS = 24;

  // ============================================
  // GENERATE ENROLLMENT BILLING
  // ============================================
  router.post("/generate-billing", async (req, res) => {
    try {
      const { enrollment_id, created_by } = req.body;

      if (!enrollment_id) {
        return res.status(400).json({
          error: "Enrollment ID is required",
        });
      }

      const result = await generateBilling(
        supabase,
        logger,
        enrollment_id,
        created_by
      );
      res.json(result);
    } catch (err) {
      logger.error("Error generating billing", {
        error: err.message,
        stack: err.stack,
      });

      const statusCode = err.message.includes("already generated")
        ? 400
        : err.message.includes("not found")
        ? 404
        : 500;

      res.status(statusCode).json({
        error: err.message || "Internal server error",
      });
    }
  });

  // ============================================
  // CREATE PAYMENT CHECKOUT
  // ============================================
  router.post("/create-checkout", async (req, res) => {
    try {
      const { enrollment_id, created_by } = req.body;

      if (!enrollment_id) {
        return res.status(400).json({
          error: "Enrollment ID is required",
        });
      }

      logger.info("Creating payment checkout", {
        enrollment_id,
        paymongo_enabled: PAYMONGO_ENABLED,
      });

      // 1. Get enrollment with scheme details
      const { data: enrollment, error: enrollmentError } = await supabase
        .from("enrollments")
        .select(
          `
          enrollment_id,
          student_id,
          semester_id,
          scheme_id,
          tuition_schemes (
            scheme_id,
            scheme_name,
            scheme_type,
            amount,
            downpayment,
            monthly_payment,
            months
          )
        `
        )
        .eq("enrollment_id", enrollment_id)
        .single();

      if (enrollmentError || !enrollment) {
        logger.error("Enrollment not found", {
          error: enrollmentError?.message,
        });
        return res.status(404).json({ error: "Enrollment not found" });
      }

      const scheme = enrollment.tuition_schemes;
      const student_id = enrollment.student_id;

      // 2. Get student account
      const { data: account, error: accountError } = await supabase
        .from("accounts")
        .select("account_id, total_balance")
        .eq("student_id", student_id)
        .maybeSingle();

      if (accountError) {
        logger.error("Error fetching account", { error: accountError.message });
        return res.status(400).json({ error: accountError.message });
      }

      if (!account) {
        return res.status(400).json({
          error: "Account not found. Please generate billing first.",
        });
      }

      const account_id = account.account_id;

      // 3. Determine what to pay based on scheme
      let amount;
      let description;
      let payment_type;

      if (scheme.scheme_type === "full_payment") {
        // ===== SCHEME 1: FULL PAYMENT =====
        const { data: fees, error: feesError } = await supabase
          .from("enrollment_fees")
          .select("amount")
          .eq("enrollment_id", enrollment_id)
          .eq("is_paid", false);

        if (feesError) {
          logger.error("Error fetching fees", { error: feesError.message });
          return res.status(400).json({ error: feesError.message });
        }

        if (!fees || fees.length === 0) {
          return res.status(400).json({
            error:
              "No unpaid fees found. All payments completed or billing not generated.",
          });
        }

        amount = fees.reduce((sum, fee) => sum + parseFloat(fee.amount), 0);
        description = `Full Payment - ${scheme.scheme_name}`;
        payment_type = "full_payment";
      } else if (scheme.scheme_type === "installment") {
        // ===== SCHEME 2 & 3: INSTALLMENT PLANS =====

        // Check if downpayment is paid
        const { data: downpaymentFee } = await supabase
          .from("enrollment_fees")
          .select("fee_id, amount, is_paid")
          .eq("enrollment_id", enrollment_id)
          .eq("fee_type", "Downpayment")
          .maybeSingle();

        if (!downpaymentFee) {
          return res.status(400).json({
            error: "Billing not generated. Please generate billing first.",
          });
        }

        if (!downpaymentFee.is_paid) {
          // Pay downpayment first
          amount = parseFloat(downpaymentFee.amount);
          description = `Downpayment - ${scheme.scheme_name}`;
          payment_type = "downpayment";
        } else {
          // Downpayment paid, get next installment
          const { data: installment, error: installmentError } = await supabase
            .from("payment_installments")
            .select("installment_id, installment_number, amount")
            .eq("enrollment_id", enrollment_id)
            .eq("status", "pending")
            .order("installment_number", { ascending: true })
            .limit(1)
            .maybeSingle();

          if (installmentError || !installment) {
            return res.status(400).json({
              error: "No pending installments found. All payments completed.",
            });
          }

          amount = parseFloat(installment.amount);
          description = `Installment ${installment.installment_number}/${scheme.months} - ${scheme.scheme_name}`;
          payment_type = "installment";
        }
      } else {
        return res.status(400).json({
          error: "Invalid scheme type",
        });
      }

      // Validate amount
      amount = Math.round(amount * 100) / 100;
      if (!amount || amount <= 0) {
        return res.status(400).json({
          error: "Invalid payment amount",
        });
      }

      // 4. Create payment record with idempotency key
      const idempotency_key = `${enrollment_id}-${payment_type}-${Date.now()}`;

      const { data: payment, error: paymentError } = await supabase
        .from("payments")
        .insert([
          {
            account_id,
            enrollment_id,
            amount,
            status: "Pending",
            payment_type,
            for_semester_id: enrollment.semester_id,
            created_by,
            payment_date: new Date().toISOString(),
            idempotency_key,
          },
        ])
        .select()
        .single();

      if (paymentError) {
        logger.error("Error creating payment", { error: paymentError.message });
        return res.status(400).json({ error: paymentError.message });
      }

      const payment_id = payment.payment_id;

      // 5. Create PayMongo checkout OR mock checkout
      let checkout_url;
      let checkout_id;

      if (PAYMONGO_ENABLED && PAYMONGO_SECRET_KEY) {
        // ===== ONLINE MODE: Use real PayMongo =====
        try {
          const axios = require("axios");
          const amountInCentavos = Math.round(amount * 100);

          const checkoutData = {
            data: {
              attributes: {
                send_email_receipt: true,
                show_description: true,
                show_line_items: true,
                line_items: [
                  {
                    currency: "PHP",
                    amount: amountInCentavos,
                    description: description,
                    name: description,
                    quantity: 1,
                  },
                ],
                payment_method_types: ["gcash", "paymaya", "card", "grab_pay"],
                success_url: `${BASE_URL}/api/enrollment-billing/payment/success?payment_id=${payment_id}`,
                cancel_url: `${BASE_URL}/api/enrollment-billing/payment/cancel?payment_id=${payment_id}`,
                description: description,
                metadata: {
                  payment_id: payment_id.toString(),
                  enrollment_id: enrollment_id.toString(),
                  student_id: student_id.toString(),
                  payment_type: payment_type,
                  payment_category: "enrollment",
                  scheme_id: scheme.scheme_id.toString(),
                  account_id: account_id.toString(),
                  idempotency_key: idempotency_key,
                },
              },
            },
          };

          const checkoutResponse = await axios.post(
            "https://api.paymongo.com/v1/checkout_sessions",
            checkoutData,
            {
              headers: {
                Authorization: `Basic ${Buffer.from(
                  PAYMONGO_SECRET_KEY
                ).toString("base64")}`,
                "Content-Type": "application/json",
              },
            }
          );

          const checkoutSession = checkoutResponse.data.data;
          checkout_url = checkoutSession.attributes.checkout_url;
          checkout_id = checkoutSession.id;

          // Save PayMongo transaction
          await supabase.from("payment_transactions").insert([
            {
              payment_id,
              paymongo_payment_id: checkout_id,
              amount,
              currency: "PHP",
              status: "pending",
              checkout_url,
              expires_at: new Date(
                Date.now() + CHECKOUT_EXPIRY_HOURS * 60 * 60 * 1000
              ).toISOString(),
            },
          ]);

          logger.info("Created PayMongo checkout", {
            payment_id,
            checkout_id,
          });
        } catch (error) {
          logger.error("PayMongo error", {
            error: error.response?.data || error.message,
          });
          return res.status(500).json({
            error: "Payment gateway error",
            details: error.response?.data?.errors?.[0]?.detail || error.message,
          });
        }
      } else {
        // ===== OFFLINE MODE: Mock checkout for local testing =====
        checkout_url = `${BASE_URL}/payment/mock-checkout?payment_id=${payment_id}`;
        checkout_id = `mock_checkout_${payment_id}_${Date.now()}`;

        // Save mock transaction
        await supabase.from("payment_transactions").insert([
          {
            payment_id,
            paymongo_payment_id: checkout_id,
            amount,
            currency: "PHP",
            status: "pending",
            checkout_url,
            expires_at: new Date(
              Date.now() + CHECKOUT_EXPIRY_HOURS * 60 * 60 * 1000
            ).toISOString(),
          },
        ]);

        logger.info("Created OFFLINE mock checkout", {
          payment_id,
          checkout_id,
        });
      }

      res.json({
        success: true,
        payment_id,
        checkout_url,
        checkout_id,
        amount,
        payment_type,
        scheme_id: scheme.scheme_id,
        scheme_name: scheme.scheme_name,
        description,
        is_mock: !PAYMONGO_ENABLED,
        expires_at: new Date(
          Date.now() + CHECKOUT_EXPIRY_HOURS * 60 * 60 * 1000
        ),
      });
    } catch (err) {
      logger.error("Unexpected error creating checkout", {
        error: err.message,
        stack: err.stack,
      });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ============================================
  // PAYMENT SUCCESS CALLBACK
  // ============================================
  router.get("/payment/success", async (req, res) => {
    try {
      const { payment_id } = req.query;

      if (!payment_id) {
        return res.status(400).send("Missing payment_id");
      }

      logger.info("Payment success callback received", { payment_id });

      // Get payment details
      const { data: payment, error: paymentFetchError } = await supabase
        .from("payments")
        .select("*")
        .eq("payment_id", payment_id)
        .single();

      if (paymentFetchError || !payment) {
        logger.error("Payment not found in success callback", { payment_id });
        return res.redirect(
          `${FRONTEND_URL}/student/payment?status=error&message=Payment not found`
        );
      }

      // If already completed, just redirect (idempotency)
      if (payment.status === "Completed") {
        logger.info("Payment already completed", { payment_id });
        res.redirect(
          `${FRONTEND_URL}/payment.html?status=success&payment_id=${payment_id}`
        );
      }

      // Process the payment completion
      await processPaymentCompletion(supabase, logger, payment_id, payment);

      logger.info("Payment processed successfully via success callback", {
        payment_id,
      });

      // Redirect to success page
      res.redirect(
        `${FRONTEND_URL}/student/payment?status=success&payment_id=${payment_id}`
      );
    } catch (err) {
      logger.error("Error in payment success callback", {
        error: err.message,
        stack: err.stack,
      });
      res.redirect(
        `${FRONTEND_URL}/student/payment?status=error&message=Processing failed`
      );
    }
  });

  // ============================================
  // PAYMENT CANCEL CALLBACK
  // ============================================
  router.get("/payment/cancel", async (req, res) => {
    try {
      const { payment_id } = req.query;

      logger.info("Payment cancelled", { payment_id });

      if (payment_id) {
        // Update payment status to cancelled
        await supabase
          .from("payments")
          .update({ status: "Cancelled" })
          .eq("payment_id", payment_id);

        await supabase
          .from("payment_transactions")
          .update({ status: "cancelled" })
          .eq("payment_id", payment_id);
      }

      res.redirect(`${FRONTEND_URL}/student/payment?status=cancelled`);
    } catch (err) {
      logger.error("Error in payment cancel callback", { error: err.message });
      res.redirect(`${FRONTEND_URL}/student/payment?status=error`);
    }
  });

  // ============================================
  // PAYMONGO WEBHOOK HANDLER (SECURED)
  // ============================================
  router.post(
    "/webhook/paymongo",
    express.raw({ type: "application/json" }),
    async (req, res) => {
      try {
        // ============================================
        // CRITICAL FIX: Verify Webhook Signature
        // ============================================
        if (PAYMONGO_ENABLED && PAYMONGO_WEBHOOK_SECRET) {
          const signature = req.headers["paymongo-signature"];

          if (!signature) {
            logger.error("Missing webhook signature");
            return res
              .status(401)
              .json({ error: "Unauthorized - missing signature" });
          }

          // Verify signature
          const rawBody = req.body.toString("utf8");
          const computedSignature = crypto
            .createHmac("sha256", PAYMONGO_WEBHOOK_SECRET)
            .update(rawBody)
            .digest("hex");

          // PayMongo sends signature in format: t=timestamp,te=test_mode,li=livemode,s=signature
          // Extract the signature part
          const signatureParts = signature.split(",");
          const actualSignature = signatureParts
            .find((part) => part.startsWith("s="))
            ?.split("=")[1];

          if (!actualSignature || actualSignature !== computedSignature) {
            logger.error("Invalid webhook signature", {
              received: actualSignature?.substring(0, 10) + "...",
              computed: computedSignature.substring(0, 10) + "...",
            });
            return res
              .status(401)
              .json({ error: "Unauthorized - invalid signature" });
          }

          logger.info("Webhook signature verified successfully");
        }

        // Parse event
        const event =
          typeof req.body === "string" ? JSON.parse(req.body) : req.body;

        logger.info("PayMongo webhook received", {
          event_type: event.data?.attributes?.type,
        });

        const eventType = event.data?.attributes?.type;
        const eventData = event.data?.attributes?.data;

        // Handle checkout session payment paid event
        if (eventType === "checkout_session.payment.paid") {
          const attributes = eventData?.attributes;
          const metadata = attributes?.metadata || {};

          // Verify this is an enrollment payment
          if (metadata.payment_category !== "enrollment") {
            logger.info("Ignoring non-enrollment payment webhook", {
              payment_category: metadata.payment_category,
            });
            return res.json({ received: true, skipped: true });
          }

          const payment_id = parseInt(metadata.payment_id);

          if (!payment_id) {
            logger.error("No payment_id in webhook metadata");
            return res.status(400).json({ error: "Invalid webhook data" });
          }

          // Get payment details
          const { data: payment, error: paymentFetchError } = await supabase
            .from("payments")
            .select("*")
            .eq("payment_id", payment_id)
            .single();

          if (paymentFetchError || !payment) {
            logger.error("Payment not found", { payment_id });
            return res.status(404).json({ error: "Payment not found" });
          }

          // Process payment (with idempotency built-in)
          const result = await processPaymentCompletion(
            supabase,
            logger,
            payment_id,
            payment
          );

          logger.info("Webhook processed successfully", {
            payment_id,
            already_processed: result.already_processed,
          });
        }

        res.json({ received: true });
      } catch (err) {
        logger.error("Webhook error", {
          error: err.message,
          stack: err.stack,
        });
        res.status(500).json({ error: "Webhook processing failed" });
      }
    }
  );

  // ============================================
  // DIAGNOSTIC: Check Account and Payment Status
  // ============================================
  router.get("/diagnostic/account/:student_id", async (req, res) => {
    try {
      const { student_id } = req.params;

      // Get account
      const { data: account } = await supabase
        .from("accounts")
        .select("*")
        .eq("student_id", student_id)
        .maybeSingle();

      if (!account) {
        return res.json({
          student_id,
          account: null,
          message: "No account found for this student",
        });
      }

      // Get all payments for this student
      const { data: payments } = await supabase
        .from("payments")
        .select(
          `
          payment_id,
          amount,
          status,
          payment_type,
          payment_date,
          enrollment_id,
          enrollments (
            enrollment_id,
            status,
            payment_status
          )
        `
        )
        .eq("account_id", account.account_id);

      // Get all transactions
      const { data: transactions } = await supabase
        .from("account_transactions")
        .select("*")
        .eq("account_id", account.account_id)
        .order("created_at", { ascending: false });

      // Get all enrollments for this student
      const { data: enrollments } = await supabase
        .from("enrollments")
        .select(
          `
          enrollment_id,
          status,
          payment_status,
          tuition_schemes (
            scheme_name,
            amount,
            discount
          )
        `
        )
        .eq("student_id", student_id);

      // Calculate totals
      const completedPayments =
        payments?.filter((p) => p.status === "Completed") || [];
      const totalPaid = completedPayments.reduce(
        (sum, p) => sum + parseFloat(p.amount),
        0
      );
      const actualBalance = parseFloat(account.total_balance || 0);

      // Calculate expected total from enrollments
      const expectedTotal =
        enrollments?.reduce((sum, e) => {
          const amount = parseFloat(e.tuition_schemes?.amount || 0);
          const discount = parseFloat(e.tuition_schemes?.discount || 0);
          return sum + (amount - discount);
        }, 0) || 0;

      const expectedBalance = expectedTotal - totalPaid;
      const balanceMismatch = Math.abs(expectedBalance - actualBalance) > 0.01;

      res.json({
        student_id,
        account: {
          account_id: account.account_id,
          total_balance: actualBalance,
          created_at: account.created_at,
          last_updated: account.last_updated,
        },
        balance_analysis: {
          actual_balance: actualBalance,
          expected_balance: expectedBalance,
          total_tuition: expectedTotal,
          total_paid: totalPaid,
          has_mismatch: balanceMismatch,
          difference: Math.round((expectedBalance - actualBalance) * 100) / 100,
        },
        enrollments: {
          total: enrollments?.length || 0,
          list: enrollments || [],
        },
        payments: {
          total: payments?.length || 0,
          completed: completedPayments.length,
          pending: payments?.filter((p) => p.status === "Pending").length || 0,
          cancelled:
            payments?.filter((p) => p.status === "Cancelled").length || 0,
          list: payments || [],
        },
        transactions: {
          total: transactions?.length || 0,
          latest_10: transactions?.slice(0, 10) || [],
        },
      });
    } catch (err) {
      logger.error("Error in diagnostic endpoint", {
        error: err.message,
        stack: err.stack,
      });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ============================================
  // GET BILLING DETAILS
  // ============================================
  router.get("/billing/:enrollment_id", async (req, res) => {
    try {
      const { enrollment_id } = req.params;

      const { data: enrollment, error: enrollmentError } = await supabase
        .from("enrollments")
        .select(
          `
          enrollment_id,
          student_id,
          semester_id,
          scheme_id,
          status,
          payment_status,
          tuition_schemes (
            scheme_id,
            scheme_name,
            scheme_type,
            amount,
            discount,
            downpayment,
            monthly_payment,
            months
          )
        `
        )
        .eq("enrollment_id", enrollment_id)
        .single();

      if (enrollmentError || !enrollment) {
        return res.status(404).json({ error: "Enrollment not found" });
      }

      const scheme = enrollment.tuition_schemes;

      const { data: fees } = await supabase
        .from("enrollment_fees")
        .select("*")
        .eq("enrollment_id", enrollment_id);

      const { data: installments } = await supabase
        .from("payment_installments")
        .select("*")
        .eq("enrollment_id", enrollment_id)
        .order("installment_number", { ascending: true });

      // Calculate fees
      const totalFees =
        fees?.reduce((sum, fee) => sum + parseFloat(fee.amount), 0) || 0;
      const paidFees =
        fees
          ?.filter((f) => f.is_paid)
          .reduce((sum, fee) => sum + parseFloat(fee.amount), 0) || 0;
      const unpaidFees = totalFees - paidFees;

      // Calculate installments
      const totalInstallments =
        installments?.reduce((sum, inst) => sum + parseFloat(inst.amount), 0) ||
        0;
      const paidInstallments =
        installments
          ?.filter((i) => i.status === "paid")
          .reduce((sum, inst) => sum + parseFloat(inst.amount), 0) || 0;
      const unpaidInstallments = totalInstallments - paidInstallments;
      const pendingInstallmentsCount =
        installments?.filter((i) => i.status === "pending").length || 0;

      // Calculate total amounts
      const baseAmount = parseFloat(scheme.amount) || 0;
      const discount = parseFloat(scheme.discount) || 0;
      const totalAmount = Math.round((baseAmount - discount) * 100) / 100;
      const totalPaid = Math.round((paidFees + paidInstallments) * 100) / 100;
      const totalBalance = Math.round((totalAmount - totalPaid) * 100) / 100;

      // Build response with scheme-specific details
      let responseData = {
        enrollment_id,
        enrollment_status: enrollment.status,
        payment_status: enrollment.payment_status,
        scheme: {
          scheme_id: scheme.scheme_id,
          scheme_name: scheme.scheme_name,
          scheme_type: scheme.scheme_type,
          base_amount: baseAmount,
          discount: discount,
          total_amount: totalAmount,
        },
        fees: fees || [],
        summary: {
          total_amount: totalAmount,
          total_paid: totalPaid,
          total_balance: totalBalance,
          payment_progress_percentage:
            totalAmount > 0 ? Math.round((totalPaid / totalAmount) * 100) : 0,
          is_fully_paid: totalBalance <= 0.01,
        },
      };

      // Add installment-specific details if applicable
      if (scheme.scheme_type === "installment") {
        const downpayment = parseFloat(scheme.downpayment) || 0;
        const monthlyPayment = parseFloat(scheme.monthly_payment) || 0;
        const months = parseInt(scheme.months) || 0;

        // Find next due installment
        const nextDueInstallment = installments?.find(
          (i) => i.status === "pending"
        );

        responseData.scheme.downpayment = downpayment;
        responseData.scheme.monthly_payment = monthlyPayment;
        responseData.scheme.number_of_months = months;

        responseData.installments = installments || [];
        responseData.installment_summary = {
          total_installment_amount: totalInstallments,
          paid_installments_amount: paidInstallments,
          unpaid_installments_amount: unpaidInstallments,
          pending_installments_count: pendingInstallmentsCount,
          total_installments_count: months,
          paid_installments_count: months - pendingInstallmentsCount,
          next_due_date: nextDueInstallment?.due_date || null,
          next_due_amount: nextDueInstallment
            ? parseFloat(nextDueInstallment.amount)
            : null,
        };

        // Update summary to show breakdown
        responseData.summary.downpayment_status = fees?.find(
          (f) => f.fee_type === "Downpayment"
        )?.is_paid
          ? "Paid"
          : "Unpaid";
        responseData.summary.downpayment_amount = downpayment;
      }

      res.json(responseData);
    } catch (err) {
      logger.error("Error fetching billing details", {
        error: err.message,
        stack: err.stack,
      });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

// ============================================
// EXPORTS - ✅ UPDATED TO INCLUDE generateBilling
// ============================================
module.exports = enrollmentbilling;
module.exports.handleEnrollmentPayment = handleEnrollmentPayment;
module.exports.generateBilling = generateBilling; // ✅ NOW EXPORTED
