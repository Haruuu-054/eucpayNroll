// routes/semesters.js
const express = require("express");

// We export a function that takes Supabase + logger (like your other routes)
function createSemestersRouter(supabase, logger) {
  const router = express.Router();

  // GET all semesters
router.get("/", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("semesters")
      .select("*")
      .order("semester_id", { ascending: true }); // ✅ sort ascending

    if (error) {
      logger.error("Error fetching semesters:", error.message);
      return res.status(400).json({ error: error.message });
    }

    res.json({ success: true, data });
  } catch (err) {
    logger.error("Unexpected error in /semesters:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});


router.put("/:semester_id", async (req, res) => {
  try {
    const { semester_id } = req.params;
    const { school_year, start_date, end_date } = req.body;

    // ✅ Validate required fields
    if (!school_year || !start_date || !end_date) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // ✅ Update record
    const { data, error } = await supabase
      .from("semesters")
      .update({
        school_year,
        start_date,
        end_date,
      })
      .eq("semester_id", semester_id)
      .select();

    if (error) {
      logger.error("Error updating semester:", error.message);
      return res.status(400).json({ error: error.message });
    }

    if (!data || data.length === 0) {
      return res.status(404).json({ msg: "Semester not found" });
    }

    // ✅ Successful update
    res.json({
      success: true,
      message: "Semester updated successfully",
      data,
    });
  } catch (err) {
    logger.error("Unexpected error in PUT /semesters/:semester_id:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});


  return router;
}

module.exports = createSemestersRouter;
