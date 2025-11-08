const express = require("express");

function createAdmissionsRouter(supabase) {
  const router = express.Router();

  //get the total admissions
  router.get("/total", async (req, res) => {
    const { count, error } = await supabase
      .from("form_responses")
      .select("*", { count: "exact", head: true });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ total_admissions: count });
  });

  // Get admission applicants per course dynamically
  router.get("/:course", async (req, res) => {
    try {
      // get the course from the URL
      const course = req.params.course;

      // optional: map shorthand to full name
      const courseMap = {
        bscs: "BS-Computer Science",
        bsn: "BS-Nursing",
        beed: "Bachelor of Elementary Education (Generalist)",
        associate: "Associate in Computer Studies", // ✅ corrected
        ab: "AB-Psychology", // make lowercase for key consistency
        coe: "BS-Computer Engineering",
        accountancy: "BS-Accountancy",
        tourism: "BS-Tourism Management",
        culinary: "BS-Hospitality Management (Culinary)",
        cruise: "BS-Hospitality Management (Cruise)",
        bsee: "Bachelor of Secondary Education (English)",
        bses: "Bachelor of Secondary Education (Science)",
        bsem: "Bachelor of Secondary Education (Math)",
        bsef: "Bachelor of Secondary Education (Filipino)",
        bsess: "Bachelor of Secondary Education (Social Science)",
        bsahr: "BS-Accountancy (Human Resource)",
        bsafm: "BS-Accountancy (Financial Management)",
        bsam: "BS-Accountancy (Marketing)",
      };

      const preferredCourse = courseMap[course.toLowerCase()] || course;

      const { data, count, error } = await supabase
        .from("form_responses")
        .select("*", { count: "exact" })
        .eq("preferred_course", preferredCourse);

      if (error) {
        return res.status(400).json({ error: error.message });
      }

      res.json({ applicants: data, total: count });
    } catch (err) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

module.exports = createAdmissionsRouter;
