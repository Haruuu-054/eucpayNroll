const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const cors = require("cors");
const path = require("path");
require("dotenv").config();
const winston = require("winston");
require('./services/installmentcron');

// Configure Winston Logger FIRST
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json()
  ),
  defaultMeta: { service: "enrollment-system" },
  transports: [
    new winston.transports.File({ filename: "error.log", level: "error" }),
    new winston.transports.File({ filename: "combined.log" }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
    }),
  ],
});

const createEnrolledStudentsRouter = require("./routes/enrolledstudents");

// Environment variables should be used instead of hardcoded credentials
const SUPABASE_URL = process.env.SUPABASE_URL || "https://zlmrtqwyiqzcyhftplhz.supabase.co";
const SUPABASE_KEY =
  process.env.SUPABASE_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpsbXJ0cXd5aXF6Y3loZnRwbGh6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDk1NTk2MzYsImV4cCI6MjA2NTEzNTYzNn0.1JUEPNsXEpEtvceV2z9lgDVhlLdPzYwgpQ48OU5ewsU";

// Initialize Supabase SECOND
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
});


// Import Router creators THIRD (after dependencies are ready)
const createMainRouter = require("./routes/main");
const createApplicantsRouter = require("./routes/applicants");
const createAdmissionsRouter = require("./routes/admissions");
const createEnrollmentRouter = require("./routes/enrollment");
const createNotificationsRouter = require("./routes/notifications");
const createEmailRouter = require("./routes/email");
const createRolesRouter = require("./routes/roles");
const createUsersRouter = require("./routes/users");
const createStudentsRouter = require("./routes/students");
const createDepartmentsRouter = require("./routes/departments");
const createProgramsRouter = require("./routes/programs");
const { createEnrollmentPeriodsRouter } = require("./routes/enrollmentPeriods");
const createSemestersRouter = require("./routes/semesters");
const subjectsrouter = require("./routes/subjects");
const createSchedulesRouter = require("./routes/schedules");
const createCoursesRouter = require("./routes/courses");
const createEnrollmentProcessRouter = require("./routes/enrollment");
const {enrollmentstatus, enrolledcounts, pendingcounts} = require("./routes/enrollment_status");
const createPaymentsRouter = require("./routes/payments");
const getallpayments = require("./routes/allpayments");
const enrollmentbilling = require("./routes/billing");


// Create router instances FOURTH (now supabase and logger exist)
const enrollmentPeriodsRouter = createEnrollmentPeriodsRouter(supabase, logger);
const enrollmentRouter = createEnrollmentRouter(supabase, logger);
const semestersRouter = createSemestersRouter(supabase, logger);
const enrolledStudentsRouter = createEnrolledStudentsRouter(supabase, logger);

const tuitionnotifsRouter = require('./routes/tuitionremind');


const app = express();
const port = process.env.PORT || 3000;



// ============================================
// MIDDLEWARE CONFIGURATION
// ============================================
app.use(cors());

// CRITICAL: Raw body parser for PayMongo webhook MUST come BEFORE express.json()
// This preserves the raw request body needed for webhook signature verification
app.use('/enrollment/webhook/paymongo', express.raw({ type: 'application/json' }));
app.use('/billing/webhook/paymongo', express.raw({ type: 'application/json' }));

// Standard JSON body parser for all other routes
app.use(express.json());

// Static file serving
app.use(express.static(path.join(__dirname, "..")));
app.use(express.static(path.join(__dirname, "public")));
app.use("/university-login-page", express.static(path.join(__dirname)));

// Avoid favicon 404 noise (also available in main router)
app.get("/favicon.ico", (req, res) => res.status(204).end());

// ============================================
// MOUNT MODULAR ROUTERS
// ============================================

// Base/general endpoints
app.use("/", createMainRouter(supabase, logger)); 
app.use('/check', createMainRouter(supabase,logger));// /check-registration, /user-details, /student-profile

// Domain routers
app.use("/applicants", createApplicantsRouter(supabase));
app.use("/admissions", createAdmissionsRouter(supabase));
app.use("/enrollments", enrollmentRouter);
app.use("/notifications", createNotificationsRouter(supabase));
app.use("/roles", createRolesRouter(supabase));
app.use("/users", createUsersRouter(supabase));
app.use("/students", createStudentsRouter(supabase, logger));
app.use("/departments", createDepartmentsRouter(supabase));
app.use("/programs", createProgramsRouter(supabase));
app.use("/enrollment-periods", enrollmentPeriodsRouter);
app.use('/api/enrollment-periods', enrollmentPeriodsRouter);
app.use('/api/enrollments', enrollmentRouter);
app.use("/semesters", semestersRouter);
app.use("/api/enrolled-students", enrolledStudentsRouter);
app.use("/subjects", subjectsrouter(supabase));
app.use("/api/schedules", createSchedulesRouter(supabase));
app.use("/api/courses", createCoursesRouter(supabase));
app.use('/create', createEnrollmentProcessRouter);
app.use('/enrollment-status', enrollmentstatus(supabase, logger));
app.use('/enrolled', enrolledcounts(supabase, logger));
app.use('/pending', pendingcounts(supabase, logger));
app.use("/api/email", createEmailRouter(supabase));
app.use('/api/payments', createPaymentsRouter(supabase, logger));

// Payment aggregation routes
app.use('/allpayments', getallpayments(supabase, logger));
app.use('/paymentsum', getallpayments(supabase, logger));
app.use('/dailypayments', getallpayments(supabase, logger));
app.use('/weeklypayments', getallpayments(supabase, logger));
app.use('/monthlypayments', getallpayments(supabase, logger));
app.use('/yearlypayments', getallpayments(supabase, logger));
app.use('/percents', getallpayments(supabase, logger));
app.use('/all', getallpayments(supabase, logger));

// Other routes
app.use('/course/schedules', createSchedulesRouter(supabase));
app.use('/next-sem', createMainRouter(supabase, logger));
app.use('/tuiton-sem', createMainRouter(supabase, logger));

// Billing and enrollment payment routes
app.use('/enrollment', enrollmentbilling(supabase, logger));
app.use('/billing', enrollmentbilling(supabase, logger));
app.use('/receipt', enrollmentbilling(supabase, logger));
app.use('/api/enrollment-billing', enrollmentbilling(supabase, logger));

app.use('/enrollment', createEnrollmentProcessRouter(supabase, logger));

const testRoutes = require('./routes/testremind');
app.use('/api/test', testRoutes);

app.use('/api/student-notifications', tuitionnotifsRouter(supabase, logger));

// ============================================
// PAYMENT SUCCESS/CANCEL HANDLERS
// ============================================

// PayMongo Success Handler
app.get("/api/payment/success", async (req, res) => {
  const { payment_id } = req.query;

  if (!payment_id) {
    return res.status(400).send("Payment ID is required");
  }

  try {
    // Get payment details
    const { data: payment, error } = await supabase
      .from("payments")
      .select(`
        payment_id,
        amount,
        payment_type,
        status,
        enrollment_id,
        account_id,
        enrollments (
          student_id,
          students (
            first_name,
            last_name,
            email
          )
        )
      `)
      .eq("payment_id", payment_id)
      .single();

    if (error || !payment) {
      return res.status(404).send("Payment not found");
    }

    // Note: Actual payment processing happens via webhook
    // This page is just for user confirmation and redirect

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Payment Successful</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
          }
          .success-container {
            background: white;
            border-radius: 20px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            max-width: 500px;
            width: 100%;
            padding: 50px 40px;
            text-align: center;
            animation: slideUp 0.5s ease-out;
          }
          @keyframes slideUp {
            from {
              opacity: 0;
              transform: translateY(30px);
            }
            to {
              opacity: 1;
              transform: translateY(0);
            }
          }
          .success-icon {
            width: 80px;
            height: 80px;
            background: #10b981;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0 auto 30px;
            animation: scaleIn 0.5s ease-out 0.2s both;
          }
          @keyframes scaleIn {
            from {
              transform: scale(0);
            }
            to {
              transform: scale(1);
            }
          }
          .checkmark {
            color: white;
            font-size: 48px;
            font-weight: bold;
          }
          h1 {
            color: #10b981;
            font-size: 32px;
            margin-bottom: 15px;
          }
          .subtitle {
            color: #666;
            font-size: 16px;
            margin-bottom: 30px;
          }
          .payment-details {
            background: #f8f9fa;
            border-radius: 12px;
            padding: 25px;
            margin-bottom: 30px;
            text-align: left;
          }
          .detail-row {
            display: flex;
            justify-content: space-between;
            margin-bottom: 15px;
            padding-bottom: 15px;
            border-bottom: 1px solid #e9ecef;
          }
          .detail-row:last-child {
            border-bottom: none;
            margin-bottom: 0;
            padding-bottom: 0;
          }
          .detail-label {
            color: #6c757d;
            font-size: 14px;
          }
          .detail-value {
            color: #212529;
            font-weight: 600;
            font-size: 14px;
          }
          .amount {
            font-size: 28px;
            color: #10b981;
          }
          .btn {
            display: inline-block;
            padding: 15px 40px;
            background: #667eea;
            color: white;
            text-decoration: none;
            border-radius: 10px;
            font-weight: 600;
            font-size: 16px;
            transition: all 0.3s;
          }
          .btn:hover {
            background: #5568d3;
            transform: translateY(-2px);
            box-shadow: 0 5px 20px rgba(102, 126, 234, 0.4);
          }
          .note {
            color: #6c757d;
            font-size: 13px;
            margin-top: 20px;
          }
        </style>
      </head>
      <body>
        <div class="success-container">
          <div class="success-icon">
            <div class="checkmark">✓</div>
          </div>
          
          <h1>Payment Successful!</h1>
          <p class="subtitle">Your payment has been processed successfully</p>
          
          <div class="payment-details">
            <div class="detail-row">
              <span class="detail-label">Payment ID</span>
              <span class="detail-value">#${payment.payment_id}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Student</span>
              <span class="detail-value">${payment.enrollments?.students?.first_name || 'N/A'} ${payment.enrollments?.students?.last_name || ''}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Payment Type</span>
              <span class="detail-value">${payment.payment_type}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Amount Paid</span>
              <span class="amount">₱${parseFloat(payment.amount).toLocaleString('en-PH', { minimumFractionDigits: 2 })}</span>
            </div>
          </div>

          <a href="/dashboard" class="btn">Return to Dashboard</a>
          
          <p class="note">A receipt has been sent to your email</p>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    logger.error("Error loading payment success page", { error: err.message });
    res.status(500).send("Error loading success page");
  }
});

// PayMongo Cancel Handler
app.get("/api/payment/cancel", async (req, res) => {
  const { payment_id } = req.query;

  if (!payment_id) {
    return res.status(400).send("Payment ID is required");
  }

  try {
    // Update payment status
    await supabase
      .from("payments")
      .update({ status: "Cancelled" })
      .eq("payment_id", payment_id);

    await supabase
      .from("payment_transactions")
      .update({ status: "cancelled" })
      .eq("payment_id", payment_id);

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Payment Cancelled</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
          }
          .cancel-container {
            background: white;
            border-radius: 20px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            max-width: 500px;
            width: 100%;
            padding: 50px 40px;
            text-align: center;
          }
          .cancel-icon {
            width: 80px;
            height: 80px;
            background: #ef4444;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0 auto 30px;
          }
          .x-mark {
            color: white;
            font-size: 48px;
            font-weight: bold;
          }
          h1 {
            color: #ef4444;
            font-size: 32px;
            margin-bottom: 15px;
          }
          p {
            color: #666;
            font-size: 16px;
            margin-bottom: 30px;
          }
          .btn {
            display: inline-block;
            padding: 15px 40px;
            background: #667eea;
            color: white;
            text-decoration: none;
            border-radius: 10px;
            font-weight: 600;
            font-size: 16px;
            transition: all 0.3s;
          }
          .btn:hover {
            background: #5568d3;
            transform: translateY(-2px);
            box-shadow: 0 5px 20px rgba(102, 126, 234, 0.4);
          }
        </style>
      </head>
      <body>
        <div class="cancel-container">
          <div class="cancel-icon">
            <div class="x-mark">✕</div>
          </div>
          
          <h1>Payment Cancelled</h1>
          <p>Your payment was cancelled. No charges were made.</p>
          
          <a href="/dashboard" class="btn">Return to Dashboard</a>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    logger.error("Error processing payment cancellation", { error: err.message });
    res.status(500).send("Error processing cancellation");
  }
});

// ============================================
// INLINE ENDPOINTS
// ============================================

// Debug course counts (sample utility)
app.get("/debug-courses", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("form_responses")
      .select("preferred_course")
      .limit(50);

    if (error) throw error;

    const courseCounts = {};
    data.forEach((item) => {
      const course = item.preferred_course;
      courseCounts[course] = (courseCounts[course] || 0) + 1;
    });

    res.json(courseCounts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Profile data aggregation
app.get("/profile", async (req, res) => {
  try {
    const { data, error } = await supabase.from("form_responses").select(`
        firstname,
        suffix,
        middlename,
        lastname,
        mobile_number,
        preferred_course,
        alter_course_1,
        alter_course_2
      `);

    if (error) throw error;

    if (data && data.length > 0) {
      const formattedData = data.map((applicant) => ({
        fullname: `${applicant.firstname} ${applicant.suffix || ""} ${
          applicant.middlename
        } ${applicant.lastname}`
          .replace(/\s+/g, " ")
          .trim(),
        mobile_number: applicant.mobile_number,
        preferred_course: applicant.preferred_course,
        alter_course_1: applicant.alter_course_1,
        alter_course_2: applicant.alter_course_2,
      }));

      res.json(formattedData);
    } else {
      res.status(404).json({ msg: "No applicants found!" });
    }
  } catch (err) {
    logger.error("/profile error", { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Search endpoint
app.get("/search", async (req, res) => {
  try {
    const {
      admission_id,
      firstname,
      strand_taken,
      preferred_course,
      alter_course_1,
      alter_course_2,
    } = req.query;

    const filters = [];

    if (admission_id) filters.push(`admission_id.eq.${admission_id}`);
    if (firstname) filters.push(`firstname.ilike.%${firstname}%`);
    if (strand_taken) filters.push(`strand_taken.ilike.%${strand_taken}%`);
    if (preferred_course)
      filters.push(`preferred_course.ilike.%${preferred_course}%`);
    if (alter_course_1)
      filters.push(`alter_course_1.ilike.%${alter_course_1}%`);
    if (alter_course_2)
      filters.push(`alter_course_2.ilike.%${alter_course_2}%`);

    if (filters.length === 0) {
      return res
        .status(400)
        .json({ error: "At least one search parameter is required." });
    }

    const { data, error } = await supabase
      .from("form_responses")
      .select("*")
      .or(filters.join(","));

    if (error) throw error;

    if (data && data.length > 0) {
      res.json(data);
    } else {
      res.status(404).json({ msg: "No matching applicant found." });
    }
  } catch (err) {
    logger.error("/search error", { error: err.message });
    res.status(500).json({ error: "Internal server error", details: err.message });
  }
});

// Basic field-specific fetchers (kept for compatibility)
app.get("/admission_id", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("form_responses")
      .select("admission_id");

    if (error) throw error;
    if (data && data.length > 0) return res.json(data);
    return res.status(404).json({ msg: "No applicants found!" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/preferred_course", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("form_responses")
      .select("preferred_course");

    if (error) throw error;
    if (data && data.length > 0) return res.json(data);
    return res.status(404).json({ msg: "No applicants found!" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/mobile_number", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("form_responses")
      .select("mobile_number");

    if (error) throw error;
    if (data && data.length > 0) return res.json(data);
    return res.status(404).json({ msg: "No applicants found!" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/alter_course_1", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("form_responses")
      .select("alter_course_1");

    if (error) throw error;
    if (data && data.length > 0) return res.json(data);
    return res.status(404).json({ msg: "No applicants found!" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/alter_course_2", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("form_responses")
      .select("alter_course_2");

    if (error) throw error;
    if (data && data.length > 0) return res.json(data);
    return res.status(404).json({ msg: "No applicants found!" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Full address endpoint
app.get("/full-address", async (req, res) => {
  try {
    const { email } = req.query;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email parameter is required.",
      });
    }

    const { data, error } = await supabase
      .from("form_responses")
      .select("street, baranggay, municipality, province, home_address")
      .eq("email", String(email).toLowerCase());

    if (error) throw error;

    if (data && data.length > 0) {
      res.json(data);
    } else {
      res.status(404).json({ msg: "No applicants found!" });
    }
  } catch (err) {
    logger.error("/full-address error", { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// ============================================
// MOCK PAYMENT PAGES (FOR TESTING)
// ============================================

// Mock Payment Checkout Page (for testing without PayMongo)
app.get("/payment/mock-checkout", async (req, res) => {
  const { payment_id } = req.query;

  if (!payment_id) {
    return res.status(400).send("Payment ID is required");
  }

  try {
    // Get payment details
    const { data: payment, error } = await supabase
      .from("payments")
      .select(`
        payment_id,
        amount,
        payment_type,
        status,
        enrollment_id,
        enrollments (
          student_id,
          students (
            first_name,
            last_name
          )
        )
      `)
      .eq("payment_id", payment_id)
      .single();

    if (error || !payment) {
      return res.status(404).send("Payment not found");
    }

    // Send HTML page for mock payment
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Mock Payment Checkout</title>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
          }
          .container {
            background: white;
            border-radius: 20px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            max-width: 500px;
            width: 100%;
            padding: 40px;
          }
          h1 {
            color: #333;
            margin-bottom: 10px;
            font-size: 28px;
          }
          .subtitle {
            color: #666;
            margin-bottom: 30px;
            font-size: 14px;
          }
          .payment-info {
            background: #f8f9fa;
            border-radius: 10px;
            padding: 20px;
            margin-bottom: 30px;
          }
          .info-row {
            display: flex;
            justify-content: space-between;
            margin-bottom: 15px;
            padding-bottom: 15px;
            border-bottom: 1px solid #e0e0e0;
          }
          .info-row:last-child {
            border-bottom: none;
            margin-bottom: 0;
            padding-bottom: 0;
          }
          .label {
            color: #666;
            font-size: 14px;
          }
          .value {
            color: #333;
            font-weight: 600;
            font-size: 14px;
          }
          .amount {
            font-size: 32px;
            color: #667eea;
            font-weight: bold;
          }
          .buttons {
            display: flex;
            gap: 10px;
          }
          button {
            flex: 1;
            padding: 15px;
            border: none;
            border-radius: 10px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s;
          }
          .pay-btn {
            background: #667eea;
            color: white;
          }
          .pay-btn:hover {
            background: #5568d3;
            transform: translateY(-2px);
            box-shadow: 0 5px 20px rgba(102, 126, 234, 0.4);
          }
          .cancel-btn {
            background: #f1f3f5;
            color: #666;
          }
          .cancel-btn:hover {
            background: #e9ecef;
          }
          .badge {
            display: inline-block;
            padding: 5px 12px;
            border-radius: 20px;
            font-size: 12px;
            font-weight: 600;
            background: #e3f2fd;
            color: #1976d2;
          }
          .loading {
            text-align: center;
            color: #666;
            margin-top: 20px;
            display: none;
          }
          .spinner {
            border: 3px solid #f3f3f3;
            border-top: 3px solid #667eea;
            border-radius: 50%;
            width: 40px;
            height: 40px;
            animation: spin 1s linear infinite;
            margin: 20px auto;
          }
          @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>🧾 Payment Checkout</h1>
          <p class="subtitle">Mock payment for testing purposes</p>
          
          <div class="payment-info">
            <div class="info-row">
              <span class="label">Payment ID</span>
              <span class="value">#${payment.payment_id}</span>
            </div>
            <div class="info-row">
              <span class="label">Type</span>
              <span class="badge">${payment.payment_type}</span>
            </div>
            <div class="info-row">
              <span class="label">Student</span>
              <span class="value">${payment.enrollments?.students?.first_name || 'N/A'} ${payment.enrollments?.students?.last_name || ''}</span>
            </div>
            <div class="info-row">
              <span class="label">Amount to Pay</span>
              <span class="amount">₱${parseFloat(payment.amount).toLocaleString('en-PH', { minimumFractionDigits: 2 })}</span>
            </div>
          </div>

          <div class="buttons">
            <button class="cancel-btn" onclick="cancelPayment()">Cancel</button>
            <button class="pay-btn" onclick="confirmPayment()">Pay Now</button>
          </div>

          <div class="loading" id="loading">
            <div class="spinner"></div>
            <p>Processing payment...</p>
          </div>
        </div>

        <script>
          function confirmPayment() {
            if (confirm('Confirm mock payment of ₱${parseFloat(payment.amount).toLocaleString('en-PH', { minimumFractionDigits: 2 })}?')) {
              document.querySelector('.buttons').style.display = 'none';
              document.getElementById('loading').style.display = 'block';
              
              setTimeout(() => {
                window.location.href = '/api/payment/success?payment_id=${payment_id}';
              }, 2000);
            }
          }

          function cancelPayment() {
            if (confirm('Cancel this payment?')) {
              window.location.href = '/api/payment/cancel?payment_id=${payment_id}';
            }
          }
        </script>
      </body>
      </html>
    `);
  } catch (err) {
    logger.error("Error loading mock checkout", { error: err.message });
    res.status(500).send("Error loading checkout page");
  }
});

app.listen(port, () => {
  logger.info(`Server running on port ${port}`);
});