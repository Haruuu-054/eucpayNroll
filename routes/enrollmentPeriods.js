const express = require("express");

/**
 * Middleware to check if enrollment is currently available
 * Can be used in any route that requires active enrollment period
 */
function createValidateEnrollmentPeriod(supabase, logger) {
  return async function validateEnrollmentPeriod(req, res, next) {
    try {
      const { data: activePeriod, error } = await supabase
        .from("enrollment_periods")
        .select("*")
        .eq("is_active", true)
        .maybeSingle();

      if (error) {
        logger.error("Error validating enrollment period", {
          error: error.message,
        });
        return res
          .status(500)
          .json({ error: "Failed to validate enrollment period" });
      }

      // No active period
      if (!activePeriod) {
        return res.status(403).json({
          error: "Enrollment is not currently open",
          reason: "no_active_period",
        });
      }

      // Check date range
      const now = new Date();
      const startDate = new Date(activePeriod.enrollment_start_date);
      const endDate = new Date(activePeriod.enrollment_end_date);

      if (now < startDate) {
        return res.status(403).json({
          error: "Enrollment has not started yet",
          reason: "not_started",
          start_date: activePeriod.enrollment_start_date,
        });
      }

      if (now > endDate) {
        return res.status(403).json({
          error: "Enrollment period has ended",
          reason: "ended",
          end_date: activePeriod.enrollment_end_date,
        });
      }

      // Enrollment is valid - attach period data to request
      req.enrollmentPeriod = activePeriod;
      next();
    } catch (err) {
      logger.error("Unexpected error validating enrollment period", {
        error: err.message,
      });
      res.status(500).json({ error: "Internal server error" });
    }
  };
}

function createEnrollmentPeriodsRouter(supabase, logger) {
  const router = express.Router();

  // Create a new enrollment period
  router.post("/", async (req, res) => {
    const {
      semester_id,
      enrollment_start_date,
      enrollment_end_date,
      is_active,
      created_by,
    } = req.body;

    if (
      !semester_id ||
      !enrollment_start_date ||
      !enrollment_end_date ||
      is_active === undefined ||
      !created_by
    ) {
      return res.status(400).json({ error: "All fields are required." });
    }

    try {
      // If setting this period as active, deactivate all other periods
      if (is_active) {
        await supabase
          .from("enrollment_periods")
          .update({ is_active: false })
          .neq("period_id", 0); // Update all records
      }

      const { data, error } = await supabase.from("enrollment_periods").insert([
        {
          semester_id,
          enrollment_start_date,
          enrollment_end_date,
          is_active,
          created_by,
        },
      ]).select(`
          *,
          semesters:semester_id (
            semester_id,
            semester_name,
            school_year,
            start_date,
            end_date
          )
        `);

      if (error) {
        logger.error("Error creating enrollment period", {
          error: error.message,
        });
        return res.status(400).json({ error: error.message });
      }

      res.status(201).json(data);
    } catch (err) {
      logger.error("Unexpected error creating enrollment period", {
        error: err.message,
      });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get all enrollment periods with semester information
  router.get("/", async (req, res) => {
    try {
      const { data, error } = await supabase
        .from("enrollment_periods")
        .select(
          `
          *,
          semesters:semester_id (
            semester_id,
            semester_name,
            school_year,
            start_date,
            end_date
          )
        `
        )
        .order("enrollment_start_date", { ascending: false });

      if (error) {
        logger.error("Error fetching enrollment periods", {
          error: error.message,
        });
        return res.status(400).json({ error: error.message });
      }

      res.json(data);
    } catch (err) {
      logger.error("Unexpected error fetching enrollment periods", {
        error: err.message,
      });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get the currently active enrollment period with semester info
  router.get("/active", async (req, res) => {
    try {
      const { data, error } = await supabase
        .from("enrollment_periods")
        .select(
          `
          *,
          semesters:semester_id (
            semester_id,
            semester_name,
            school_year,
            start_date,
            end_date
          )
        `
        )
        .eq("is_active", true)
        .order("enrollment_start_date", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) {
        logger.error("Error fetching active enrollment period", {
          error: error.message,
        });
        return res.status(400).json({ error: error.message });
      }

      if (!data) {
        return res
          .status(404)
          .json({ message: "No active enrollment period found." });
      }

      res.json(data);
    } catch (err) {
      logger.error("Unexpected error fetching active enrollment period", {
        error: err.message,
      });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Check enrollment availability (before /:id route)
  router.get("/check-availability", async (req, res) => {
    try {
      const { data: activePeriod, error } = await supabase
        .from("enrollment_periods")
        .select(
          `
        *,
        semesters:semester_id (
          semester_id,
          semester_name,
          school_year,
          start_date,
          end_date
        )
      `
        )
        .eq("is_active", true)
        .maybeSingle();

      if (error) {
        logger.error("Error checking enrollment availability", {
          error: error.message,
        });
        return res.status(400).json({ error: error.message });
      }

      if (!activePeriod) {
        return res.json({
          available: false,
          reason: "no_active_period",
          message: "Enrollment is not currently open",
          data: null,
        });
      }

      const now = new Date();
      const startDate = new Date(activePeriod.enrollment_start_date);
      const endDate = new Date(activePeriod.enrollment_end_date);

      if (now < startDate) {
        return res.json({
          available: false,
          reason: "not_started",
          message: "Enrollment has not started yet",
          start_date: activePeriod.enrollment_start_date,
          data: activePeriod,
        });
      }

      if (now > endDate) {
        return res.json({
          available: false,
          reason: "ended",
          message: "Enrollment period has ended",
          end_date: activePeriod.enrollment_end_date,
          data: activePeriod,
        });
      }

      return res.json({
        available: true,
        reason: "open",
        message: "Enrollment is currently open",
        data: activePeriod,
      });
    } catch (err) {
      logger.error("Unexpected error checking enrollment availability", {
        error: err.message,
      });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get a specific enrollment period by ID with semester info
  router.get("/:id", async (req, res) => {
    const { id } = req.params;

    try {
      const { data, error } = await supabase
        .from("enrollment_periods")
        .select(
          `
          *,
          semesters:semester_id (
            semester_id,
            semester_name,
            school_year,
            start_date,
            end_date
          )
        `
        )
        .eq("period_id", id)
        .single();

      if (error) {
        logger.error("Error fetching enrollment period", {
          error: error.message,
        });
        return res.status(400).json({ error: error.message });
      }

      if (!data) {
        return res.status(404).json({ error: "Enrollment period not found" });
      }

      res.json(data);
    } catch (err) {
      logger.error("Unexpected error fetching enrollment period", {
        error: err.message,
      });
      res.status(500).json({ error: "Internal server error" });
    }
  });

// Update an enrollment period
router.patch("/:id", async (req, res) => {
  const { id } = req.params;
  const { semester_id, enrollment_start_date, enrollment_end_date } = req.body;

  try {
    const { data, error } = await supabase
      .from("enrollment_periods")
      .update({ 
        semester_id, 
        enrollment_start_date, 
        enrollment_end_date 
      })
      .eq("period_id", id)
      .select(`
        *,
        semesters:semester_id (
          semester_id,
          semester_name,
          school_year,
          start_date,
          end_date
        )
      `);

    if (error) {
      logger.error("Error updating enrollment period", {
        error: error.message,
      });
      return res.status(400).json({ error: error.message });
    }

    res.json(data);
  } catch (err) {
    logger.error("Unexpected error updating enrollment period", {
      error: err.message,
    });
    res.status(500).json({ error: "Internal server error" });
  }
});

  // Delete an enrollment period
  router.delete("/:id", async (req, res) => {
    const { id } = req.params;

    try {
      const { data, error } = await supabase
        .from("enrollment_periods")
        .delete()
        .eq("period_id", id)
        .select();

      if (error) {
        logger.error("Error deleting enrollment period", {
          error: error.message,
        });
        return res.status(400).json({ error: error.message });
      }

      if (!data || data.length === 0) {
        return res.status(404).json({ error: "Enrollment period not found" });
      }

      res.json({ message: "Enrollment period deleted successfully", data });
    } catch (err) {
      logger.error("Unexpected error deleting enrollment period", {
        error: err.message,
      });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

module.exports = {
  createEnrollmentPeriodsRouter,
  createValidateEnrollmentPeriod,
};