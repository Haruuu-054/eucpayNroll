const express = require("express");

function getallpayments(supabase, logger) {
  const router = express.Router();

router.get("/", async (req, res) => {
  try {
    // Fetch payments with enrollments
    const { data: paymentsData, error: paymentsError } = await supabase
      .from("payments")
      .select(
        `
        payment_id,
        method,
        amount,
        status,
        payment_date,
        enrollments!inner (
          enrollment_id,
          student_id,
          scheme_id,
          status
        )
      `
      )
      .eq("status", "Completed");

    if (paymentsError) {
      logger.error("Error fetching payments:", paymentsError);
      return res.status(500).json({ error: "Internal Server Error" });
    }

    // Handle empty results
    if (!paymentsData || paymentsData.length === 0) {
      logger.info("No completed payments found");
      return res.status(200).json([]);
    }

    // Extract unique IDs
    const studentIds = [
      ...new Set(paymentsData.map((p) => p.enrollments?.student_id).filter(Boolean)),
    ];
    const schemeIds = [
      ...new Set(paymentsData.map((p) => p.enrollments?.scheme_id).filter(Boolean)),
    ];

    // Fetch related data in parallel
    const [studentsResult, schemesResult] = await Promise.all([
      supabase
        .from("students")
        .select(
          `
          student_id,
          first_name,
          last_name,
          program_id,
          programs (
            program_name
          )
        `
        )
        .in("student_id", studentIds),
      supabase
        .from("tuition_schemes")
        .select("scheme_id, scheme_name")
        .in("scheme_id", schemeIds),
    ]);

    if (studentsResult.error) {
      logger.error("Error fetching students:", studentsResult.error);
      return res.status(500).json({ error: "Internal Server Error" });
    }

    if (schemesResult.error) {
      logger.error("Error fetching schemes:", schemesResult.error);
      return res.status(500).json({ error: "Internal Server Error" });
    }

    // Create lookup maps
    const studentMap = (studentsResult.data || []).reduce((acc, student) => {
      acc[student.student_id] = student;
      return acc;
    }, {});

    const schemeMap = (schemesResult.data || []).reduce((acc, scheme) => {
      acc[scheme.scheme_id] = scheme;
      return acc;
    }, {});

    // Format response data
    const formattedData = paymentsData.map((payment) => {
      const student = studentMap[payment.enrollments?.student_id];
      const scheme = schemeMap[payment.enrollments?.scheme_id];

      return {
        payment_id: payment.payment_id,
        firstname: student?.first_name || "N/A",
        lastname: student?.last_name || "N/A",
        program: student?.programs?.program_name || "N/A",
        enrollment_status: payment.enrollments?.status || "N/A",
        tuition_scheme: scheme?.scheme_name || "N/A",
        method: payment.method || "N/A",
        amount: payment.amount,
        payment_status: payment.status,
        payment_date: payment.payment_date,
      };
    });

    logger.info(`Successfully fetched ${formattedData.length} payments`);
    res.status(200).json(formattedData);
  } catch (err) {
    logger.error("Unexpected error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// Route to get total sum of completed payments (optionally filtered by semester)
router.get("/total", async (req, res) => {
  try {
    const { semester_id, use_active } = req.query; // Get semester_id from query params or use_active flag
    
    let semesterToFilter = semester_id;

    // If use_active is true, fetch the active semester
    if (use_active === 'true') {
      const { data: activePeriod, error: periodError } = await supabase
        .from("enrollment_periods")
        .select("semester_id")
        .eq("is_active", true)
        .order("enrollment_start_date", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (periodError) {
        logger.error("Error fetching active enrollment period:", periodError);
        return res.status(400).json({ error: periodError.message });
      }

      if (!activePeriod) {
        return res.status(404).json({ 
          error: "No active enrollment period found" 
        });
      }

      semesterToFilter = activePeriod.semester_id;
    }
    
    // Build the query
    let query = supabase
      .from("payments")
      .select("amount")
      .eq("status", "Completed");
    
    // Add semester filter if provided
    if (semesterToFilter) {
      query = query.eq("for_semester_id", semesterToFilter);
    }

    const { data, error } = await query;

    if (error) {
      logger.error("Error fetching payment total:", error);
      return res.status(400).json({ error: error.message });
    }

    // Calculate sum in JavaScript
    const totalAmount = data.reduce(
      (sum, payment) => sum + Number(payment.amount),
      0
    );

    res.json({
      total_amount: totalAmount,
      count: data.length,
      ...(semesterToFilter && { semester_id: semesterToFilter }), // Include semester_id in response if filtered
    });
  } catch (err) {
    logger.error("Unexpected error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

  // Daily payments - last 30 days
  router.get("/daily", async (req, res) => {
    try {
      const { data, error } = await supabase
        .from("payments")
        .select("payment_date, amount")
        .eq("status", "Completed")
        .gte(
          "payment_date",
          new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
        )
        .order("payment_date", { ascending: true });

      if (error) {
        logger.error("Error fetching daily payments:", error);
        return res.status(400).json({ error: error.message });
      }

      // Group by date
      const dailyTotals = data.reduce((acc, payment) => {
        const date = payment.payment_date.split("T")[0]; // Get just the date part
        if (!acc[date]) {
          acc[date] = 0;
        }
        acc[date] += Number(payment.amount);
        return acc;
      }, {});

      // Format response
      const formattedData = Object.entries(dailyTotals).map(
        ([date, amount]) => ({
          date,
          total_amount: amount,
        })
      );

      res.json(formattedData);
    } catch (err) {
      logger.error("Unexpected error:", err);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  });

  // Weekly payments - last 12 weeks
  router.get("/weekly", async (req, res) => {
    try {
      const { data, error } = await supabase
        .from("payments")
        .select("payment_date, amount")
        .eq("status", "Completed")
        .gte(
          "payment_date",
          new Date(Date.now() - 84 * 24 * 60 * 60 * 1000).toISOString()
        )
        .order("payment_date", { ascending: true });

      if (error) {
        logger.error("Error fetching weekly payments:", error);
        return res.status(400).json({ error: error.message });
      }

      // Group by week
      const weeklyTotals = data.reduce((acc, payment) => {
        const date = new Date(payment.payment_date);
        const weekStart = new Date(date);
        weekStart.setDate(date.getDate() - date.getDay()); // Start of week (Sunday)
        const weekKey = weekStart.toISOString().split("T")[0];

        if (!acc[weekKey]) {
          acc[weekKey] = 0;
        }
        acc[weekKey] += Number(payment.amount);
        return acc;
      }, {});

      const formattedData = Object.entries(weeklyTotals).map(
        ([week, amount]) => ({
          week_start: week,
          total_amount: amount,
        })
      );

      res.json(formattedData);
    } catch (err) {
      logger.error("Unexpected error:", err);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  });

  // Monthly payments - last 12 months
  router.get("/monthly", async (req, res) => {
    try {
      const { data, error } = await supabase
        .from("payments")
        .select("payment_date, amount")
        .eq("status", "Completed")
        .gte(
          "payment_date",
          new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString()
        )
        .order("payment_date", { ascending: true });

      if (error) {
        logger.error("Error fetching monthly payments:", error);
        return res.status(400).json({ error: error.message });
      }

      // Group by month
      const monthlyTotals = data.reduce((acc, payment) => {
        const date = new Date(payment.payment_date);
        const monthKey = `${date.getFullYear()}-${String(
          date.getMonth() + 1
        ).padStart(2, "0")}`;

        if (!acc[monthKey]) {
          acc[monthKey] = 0;
        }
        acc[monthKey] += Number(payment.amount);
        return acc;
      }, {});

      const formattedData = Object.entries(monthlyTotals).map(
        ([month, amount]) => ({
          month,
          total_amount: amount,
        })
      );

      res.json(formattedData);
    } catch (err) {
      logger.error("Unexpected error:", err);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  });

  // Yearly payments - all years
  router.get("/yearly", async (req, res) => {
    try {
      const { data, error } = await supabase
        .from("payments")
        .select("payment_date, amount")
        .eq("status", "Completed")
        .order("payment_date", { ascending: true });

      if (error) {
        logger.error("Error fetching yearly payments:", error);
        return res.status(400).json({ error: error.message });
      }

      // Group by year
      const yearlyTotals = data.reduce((acc, payment) => {
        const year = new Date(payment.payment_date).getFullYear();

        if (!acc[year]) {
          acc[year] = 0;
        }
        acc[year] += Number(payment.amount);
        return acc;
      }, {});

      const formattedData = Object.entries(yearlyTotals).map(
        ([year, amount]) => ({
          year: parseInt(year),
          total_amount: amount,
        })
      );

      res.json(formattedData);
    } catch (err) {
      logger.error("Unexpected error:", err);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  });

  router.get("/methods", async (req, res) => {
    try {
      const { data, error } = await supabase
        .from("payment_transactions")
        .select("payment_method")
        .not("payment_method", "is", null)
        .eq("status", "paid"); // or "completed" depending on your status values

      if (error) {
        logger.error("Error fetching payment methods:", error);
        return res.status(400).json({ error: error.message });
      }

      const methodCounts = data.reduce((acc, transaction) => {
        const method = transaction.payment_method;

        if (!acc[method]) {
          acc[method] = 0;
        }
        acc[method] += 1;
        return acc;
      }, {});

      const total = data.length;

      const formattedData = Object.entries(methodCounts)
        .map(([payment_method, transaction_count]) => ({
          payment_method,
          transaction_count,
          percentage: parseFloat(
            ((transaction_count / total) * 100).toFixed(2)
          ),
        }))
        .sort((a, b) => b.percentage - a.percentage);

      res.json(formattedData);
    } catch (err) {
      logger.error("Unexpected error:", err);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  });

  // Route to get total balance of all accounts
  router.get("/total-balance", async (req, res) => {
    try {
      const { data, error } = await supabase
        .from("accounts")
        .select("total_balance");

      if (error) {
        logger.error("Error fetching account balances:", error);
        return res.status(400).json({ error: error.message });
      }

      // Compute the total sum in JavaScript
      const totalBalance = data.reduce(
        (sum, account) => sum + Number(account.total_balance || 0),
        0
      );

      res.json({
        total_balance: totalBalance,
        count: data.length,
      });
    } catch (err) {
      logger.error("Unexpected error:", err);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  });

  return router;
}

module.exports = getallpayments;
