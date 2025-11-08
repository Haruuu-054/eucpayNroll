const express = require("express");

// Import the validation middleware factory
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

      if (!activePeriod) {
        return res.status(403).json({
          error: "Enrollment is not currently open",
          reason: "no_active_period",
        });
      }

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

// ============================================
// ENROLLMENT PERIODS ROUTER
// ============================================
function createEnrollmentPeriodsRouter(supabase, logger) {
  const router = express.Router();

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
      if (is_active) {
        await supabase
          .from("enrollment_periods")
          .update({ is_active: false })
          .neq("period_id", 0);
      }

      const { data, error } = await supabase
        .from("enrollment_periods")
        .insert([
          {
            semester_id,
            enrollment_start_date,
            enrollment_end_date,
            is_active,
            created_by,
          },
        ])
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
        );

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

  router.patch("/:id", async (req, res) => {
    const { id } = req.params;
    const { enrollment_start_date, enrollment_end_date, is_active } = req.body;

    try {
      if (is_active === true) {
        await supabase
          .from("enrollment_periods")
          .update({ is_active: false })
          .neq("period_id", id);
      }

      const { data, error } = await supabase
        .from("enrollment_periods")
        .update({ enrollment_start_date, enrollment_end_date, is_active })
        .eq("period_id", id)
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
        );

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

// ============================================
// HELPER FUNCTION: Determine Correct Year Level
// ============================================
async function determineCorrectYearLevel(supabase, logger, student_id, target_semester_id) {
  try {
    logger.info("Determining correct year level", {
      student_id,
      target_semester_id,
    });

    // Get the target semester info
    const { data: targetSemester, error: semesterError } = await supabase
      .from("semesters")
      .select("semester_name, school_year")
      .eq("semester_id", target_semester_id)
      .single();

    if (semesterError) {
      logger.error("Error fetching target semester", {
        error: semesterError.message,
      });
      throw semesterError;
    }

    // Get student's last completed enrollment (most recent)
    const { data: lastCompleted, error: lastError } = await supabase
      .from("enrollments")
      .select(`
        year_level,
        semester_id,
        status,
        semesters:semester_id(semester_name, school_year)
      `)
      .eq("student_id", student_id)
      .eq("status", "Completed")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (lastError) {
      logger.error("Error fetching last completed enrollment", {
        error: lastError.message,
      });
      throw lastError;
    }

    // If no completed enrollments, student is starting fresh at Year 1
    if (!lastCompleted) {
      logger.info("No completed enrollments found - starting at Year 1", {
        student_id,
      });
      return {
        yearLevel: 1,
        isNewStudent: true,
        message: "Starting Year 1",
      };
    }

    const lastSemester = lastCompleted.semesters.semester_name.toLowerCase();
    const lastYearLevel = lastCompleted.year_level;
    const targetSemesterName = targetSemester.semester_name.toLowerCase();

    logger.info("Analyzing progression", {
      lastSemester,
      lastYearLevel,
      targetSemesterName,
    });

    // Determine progression based on semester sequence
    let correctYearLevel;
    let progressionType;

    // Case 1: Last was 1st semester, now enrolling in 2nd semester
    if (lastSemester.includes("1st") && targetSemesterName.includes("2nd")) {
      correctYearLevel = lastYearLevel; // Stay in same year
      progressionType = "same_year_progression";
      logger.info("Same year progression: 1st -> 2nd semester", {
        yearLevel: correctYearLevel,
      });
    }
    // Case 2: Last was 2nd semester, now enrolling in 1st semester (new year)
    else if (lastSemester.includes("2nd") && targetSemesterName.includes("1st")) {
      correctYearLevel = lastYearLevel + 1; // Advance to next year
      progressionType = "year_advancement";
      logger.info("Year advancement: 2nd semester -> next year 1st semester", {
        yearLevel: correctYearLevel,
      });
    }
    // Case 3: Same semester type (unusual case - re-enrollment or irregular)
    else if (
      (lastSemester.includes("1st") && targetSemesterName.includes("1st")) ||
      (lastSemester.includes("2nd") && targetSemesterName.includes("2nd"))
    ) {
      correctYearLevel = lastYearLevel;
      progressionType = "same_semester_type";
      logger.warn("Enrolling in same semester type again", {
        yearLevel: correctYearLevel,
        lastSemester,
        targetSemester: targetSemesterName,
      });
    }
    // Default fallback
    else {
      correctYearLevel = lastYearLevel;
      progressionType = "default";
      logger.warn("Unable to determine specific progression, using last year level", {
        yearLevel: correctYearLevel,
      });
    }

    return {
      yearLevel: correctYearLevel,
      isNewStudent: false,
      progressionType,
      lastEnrollment: {
        yearLevel: lastYearLevel,
        semester: lastCompleted.semesters.semester_name,
        schoolYear: lastCompleted.semesters.school_year,
      },
      message: `Progressing to Year ${correctYearLevel}`,
    };
  } catch (error) {
    logger.error("Error in determineCorrectYearLevel", {
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}

// ============================================
// ENROLLMENT ROUTER
// ============================================
function createEnrollmentRouter(supabase, logger) {
  const router = express.Router();

  const validateEnrollmentPeriod = createValidateEnrollmentPeriod(
    supabase,
    logger
  );

// ============================================
// ✅ FIXED: Check enrollment eligibility endpoint
// ============================================
router.get("/check-eligibility", async (req, res) => {
  try {
    const { student_id, semester_id } = req.query;

    if (!student_id || !semester_id) {
      return res.status(400).json({
        error: "student_id and semester_id are required",
      });
    }

    const parsedSemesterId = parseInt(semester_id);

    logger.info("Checking enrollment eligibility with auto year level", {
      student_id,
      semester_id: parsedSemesterId,
    });

    // ✅ AUTO-CALCULATE the correct year level
    const yearLevelResult = await determineCorrectYearLevel(
      supabase,
      logger,
      student_id,
      parsedSemesterId
    );

    const correctYearLevel = yearLevelResult.yearLevel;

    logger.info("Calculated correct year level", {
      student_id,
      correctYearLevel,
      progressionType: yearLevelResult.progressionType,
    });

    // ✅ Check for existing enrollment with same semester AND year level
    const { data: existingEnrollment, error: checkError } = await supabase
      .from("enrollments")
      .select("enrollment_id, status, year_level")
      .eq("student_id", student_id)
      .eq("semester_id", parsedSemesterId)
      .eq("year_level", correctYearLevel)
      .in("status", ["Pending", "Enrolled", "Validated"])
      .maybeSingle();

    if (checkError) {
      logger.error("Error checking existing enrollment", {
        error: checkError.message,
      });
    }

    if (existingEnrollment) {
      return res.json({
        canEnroll: false,
        reason: "already_enrolled",
        message: `You are already enrolled for this semester in Year ${correctYearLevel}`,
        enrollmentId: existingEnrollment.enrollment_id,
        yearLevel: correctYearLevel,
        yearLevelInfo: yearLevelResult,
      });
    }

    // ✅ FIX: Pass the calculated year_level to the RPC function
    const { data: eligibility, error: eligibilityError } = await supabase.rpc(
      "can_enroll_in_semester_enhanced_v2",
      {
        p_student_id: student_id,
        p_semester_id: parsedSemesterId,
        p_year_level: correctYearLevel, // ✅ PASS THE CALCULATED YEAR LEVEL
      }
    );

    if (eligibilityError) {
      logger.error("Error checking enrollment eligibility", {
        error: eligibilityError.message,
      });
      return res.status(500).json({
        error: "Failed to validate enrollment eligibility",
        details: eligibilityError.message,
      });
    }

    const eligibilityCheck = eligibility[0];

    logger.info("Enrollment eligibility check result", {
      can_enroll: eligibilityCheck.can_enroll,
      reason: eligibilityCheck.reason,
      message: eligibilityCheck.message,
      correctYearLevel,
    });

    res.json({
      canEnroll: eligibilityCheck.can_enroll,
      reason: eligibilityCheck.reason,
      message: eligibilityCheck.message,
      enrollmentId: eligibilityCheck.existing_enrollment_id,
      prerequisiteDetails: eligibilityCheck.prerequisite_details,
      lastEnrollmentStatus: eligibilityCheck.existing_enrollment_id
        ? "Completed"
        : null,
      // ✅ Return the calculated year level to frontend
      yearLevel: correctYearLevel,
      yearLevelInfo: yearLevelResult,
    });
  } catch (err) {
    logger.error("Error in eligibility check endpoint", {
      error: err.message,
      stack: err.stack,
    });
    res.status(500).json({ error: "Internal server error" });
  }
});

// ============================================
// ✅ FIXED: POST /enrollments - Create enrollment with auto year level
// ============================================
router.post("/", validateEnrollmentPeriod, async (req, res) => {
  const { student_id, program_id, scheme_id, semester_id, subjects } = req.body;

  const parsedProgramId = parseInt(program_id, 10);
  const parsedSchemeId = parseInt(scheme_id, 10);
  const parsedSemesterId = parseInt(semester_id, 10);

  if (
    !student_id ||
    isNaN(parsedProgramId) ||
    isNaN(parsedSchemeId) ||
    isNaN(parsedSemesterId)
  ) {
    return res.status(400).json({
      error: "student_id, program_id, scheme_id, and semester_id are required and must be valid",
    });
  }

  try {
    const activePeriod = req.enrollmentPeriod;

    if (activePeriod.semester_id !== parsedSemesterId) {
      return res.status(400).json({
        error:
          "Selected semester does not match the active enrollment period",
        active_semester_id: activePeriod.semester_id,
      });
    }

    // ✅ AUTO-CALCULATE the correct year level
    logger.info("Auto-calculating correct year level for enrollment", {
      student_id,
      semester_id: parsedSemesterId,
    });

    const yearLevelResult = await determineCorrectYearLevel(
      supabase,
      logger,
      student_id,
      parsedSemesterId
    );

    const correctYearLevel = yearLevelResult.yearLevel;

    logger.info("Calculated year level for new enrollment", {
      student_id,
      correctYearLevel,
      progressionType: yearLevelResult.progressionType,
      isNewStudent: yearLevelResult.isNewStudent,
    });

    // ✅ Check existing enrollment for this semester AND calculated year level
    const { data: existingCheck, error: existingError } = await supabase
      .from("enrollments")
      .select("enrollment_id, status, year_level")
      .eq("student_id", student_id)
      .eq("semester_id", parsedSemesterId)
      .eq("year_level", correctYearLevel)
      .in("status", ["Pending", "Enrolled", "Validated"])
      .maybeSingle();

    if (existingCheck) {
      return res.status(400).json({
        error: `You are already enrolled for this semester in Year ${correctYearLevel}`,
        reason: "already_enrolled",
        existing_enrollment_id: existingCheck.enrollment_id,
        yearLevel: correctYearLevel,
      });
    }

    // ✅ Call RPC with calculated year level for prerequisite validation
    const { data: eligibility, error: eligibilityError } = await supabase.rpc(
      "can_enroll_in_semester_enhanced_v2",
      {
        p_student_id: student_id,
        p_semester_id: parsedSemesterId,
        p_year_level: correctYearLevel, // ✅ PASS THE CALCULATED YEAR LEVEL
      }
    );

    if (eligibilityError) {
      logger.error("Error checking enrollment eligibility", {
        error: eligibilityError.message,
      });
      return res.status(500).json({
        error: "Failed to validate enrollment eligibility",
        details: eligibilityError.message,
      });
    }

    const eligibilityCheck = eligibility[0];

    logger.info("Enrollment eligibility check result", {
      can_enroll: eligibilityCheck.can_enroll,
      reason: eligibilityCheck.reason,
      message: eligibilityCheck.message,
      prerequisite_details: eligibilityCheck.prerequisite_details,
    });

    if (
      !eligibilityCheck.can_enroll &&
      eligibilityCheck.reason === "incomplete_prerequisites"
    ) {
      return res.status(400).json({
        error: eligibilityCheck.message,
        reason: eligibilityCheck.reason,
        prerequisiteDetails: eligibilityCheck.prerequisite_details,
        missing_subjects:
          eligibilityCheck.prerequisite_details?.missing_subjects || [],
        yearLevel: correctYearLevel,
      });
    }

    if (!eligibilityCheck.can_enroll) {
      return res.status(400).json({
        error: eligibilityCheck.message,
        reason: eligibilityCheck.reason,
        existing_enrollment_id: eligibilityCheck.existing_enrollment_id,
        yearLevel: correctYearLevel,
      });
    }

    // ✅ CREATE ENROLLMENT with auto-calculated year_level
    logger.info("Creating enrollment record with auto-calculated year level", {
      student_id,
      program_id: parsedProgramId,
      scheme_id: parsedSchemeId,
      semester_id: parsedSemesterId,
      year_level: correctYearLevel,
      progression_type: yearLevelResult.progressionType,
    });

    const { data: enrollment, error: enrollmentError } = await supabase
      .from("enrollments")
      .insert([
        {
          student_id,
          program_id: parsedProgramId,
          scheme_id: parsedSchemeId,
          semester_id: parsedSemesterId,
          period_id: activePeriod.period_id,
          year_level: correctYearLevel, // ✅ Using auto-calculated year level
          status: "Pending",
          payment_status: "Unpaid",
        },
      ])
      .select()
      .single();

    if (enrollmentError) {
      logger.error("Error creating enrollment", {
        error: enrollmentError.message,
      });
      return res.status(500).json({
        error: "Failed to create enrollment",
        details: enrollmentError.message,
      });
    }

    logger.info("Enrollment created successfully", {
      enrollment_id: enrollment.enrollment_id,
      year_level: enrollment.year_level,
      progression_info: yearLevelResult,
    });

    // ✅ UPDATE STUDENTS TABLE with current year level
    const { error: studentUpdateError } = await supabase
      .from("students")
      .update({ year_level: correctYearLevel })
      .eq("student_id", student_id);

    if (studentUpdateError) {
      logger.warn("Failed to update student year_level in students table", {
        error: studentUpdateError.message,
        student_id,
        year_level: correctYearLevel,
      });
      // Don't fail the enrollment, just log the warning
    } else {
      logger.info("Updated student year_level in students table", {
        student_id,
        year_level: correctYearLevel,
      });
    }

    // CREATE ENROLLMENT SUBJECTS
    if (subjects && subjects.length > 0) {
      logger.info("Creating enrollment subjects", {
        enrollment_id: enrollment.enrollment_id,
        subject_count: subjects.length,
      });

      const enrollmentSubjects = subjects.map((s) => ({
        enrollment_id: enrollment.enrollment_id,
        subject_id: parseInt(s.subject_id),
        status: "Enrolled",
      }));

      const { error: subjectsError } = await supabase
        .from("enrollment_subjects")
        .insert(enrollmentSubjects);

      if (subjectsError) {
        logger.error("Error creating enrollment subjects", {
          error: subjectsError.message,
        });
        return res.status(500).json({
          error: "Enrollment created but failed to add subjects",
          details: subjectsError.message,
          enrollment_id: enrollment.enrollment_id,
        });
      }

      logger.info("Enrollment subjects created successfully");
    }

    res.status(201).json({
      success: true,
      enrollment_id: enrollment.enrollment_id,
      year_level: correctYearLevel,
      yearLevelInfo: yearLevelResult,
      message: `Enrollment created successfully for Year ${correctYearLevel}`,
    });
  } catch (err) {
    logger.error("Unexpected error in enrollment creation", {
      error: err.message,
      stack: err.stack,
    });
    res.status(500).json({ error: "Internal server error" });
  }
});

  // ============================================
  // GET /enrollments/:student_id - Get enrollment by student ID
  // ============================================
  router.get("/:student_id", async (req, res) => {
    const { student_id } = req.params;
    const {
      enrollment_id,
      include_relations = "false",
      include_subjects = "false",
    } = req.query;

    if (!student_id) {
      logger.error("Missing student_id in request");
      return res.status(400).json({ error: "student_id is required" });
    }

    logger.info("Fetching enrollment", {
      student_id,
      enrollment_id: enrollment_id ? parseInt(enrollment_id) : null,
      include_relations,
      include_subjects,
    });

    try {
      let query = supabase
        .from("enrollments")
        .select("*")
        .eq("student_id", student_id);

      if (enrollment_id) {
        query = query.eq("enrollment_id", parseInt(enrollment_id));
      }

      const { data: enrollments, error: queryError } = await query;

      if (queryError) {
        logger.error("Basic query failed", {
          error: queryError.message,
          code: queryError.code,
          student_id,
        });
        return res.status(500).json({
          error: "Failed to fetch enrollment",
          details: queryError.message,
        });
      }

      if (!enrollments || enrollments.length === 0) {
        logger.warn("No enrollment found", { student_id, enrollment_id });
        return res.status(404).json({
          success: false,
          message: "No enrollment found for this student",
          data: null,
        });
      }

      logger.info(
        `Core enrollment fetched successfully (${enrollments.length} found)`,
        {
          student_id,
        }
      );

      let responseData = enrollments;

      if (include_relations === "true") {
        logger.info("Fetching relations for enrollments", { student_id });
        for (let enrollment of responseData) {
          const { data: student, error: studentError } = await supabase
            .from("students")
            .select(
              "first_name, last_name, dob, email, year_level, admission_year"
            )
            .eq("student_id", enrollment.student_id)
            .single();

          if (studentError) {
            logger.warn("Student fetch failed", {
              error: studentError.message,
              student_id,
            });
            enrollment.student = { error: "Student details unavailable" };
          } else {
            enrollment.student = student;
          }

          const { data: program, error: programError } = await supabase
            .from("programs")
            .select("program_name, program_code")
            .eq("program_id", enrollment.program_id)
            .single();

          if (programError) {
            logger.warn("Program fetch failed", {
              error: programError.message,
              program_id: enrollment.program_id,
            });
            enrollment.program = { error: "Program details unavailable" };
          } else {
            enrollment.program = program;
          }

          if (enrollment.semester_id) {
            const { data: semester, error: semError } = await supabase
              .from("semesters")
              .select("semester_name, school_year, start_date, end_date")
              .eq("semester_id", enrollment.semester_id)
              .single();
            if (semError) {
              logger.warn("Semester fetch failed", {
                error: semError.message,
                semester_id: enrollment.semester_id,
              });
              enrollment.semester = { error: "Semester details unavailable" };
            } else {
              enrollment.semester = semester;
            }
          }

          if (enrollment.scheme_id) {
            const { data: scheme, error: schemeError } = await supabase
              .from("tuition_schemes")
              .select(
                "scheme_name, amount, year, scheme_type, downpayment, monthly_payment"
              )
              .eq("scheme_id", enrollment.scheme_id)
              .single();
            if (schemeError) {
              logger.warn("Scheme fetch failed", {
                error: schemeError.message,
                scheme_id: enrollment.scheme_id,
              });
              enrollment.scheme = { error: "Scheme details unavailable" };
            } else {
              enrollment.scheme = scheme;
            }
          }
        }
      }

      if (include_subjects === "true") {
        logger.info("Fetching subjects for enrollments", { student_id });
        for (let enrollment of responseData) {
          const { data: subjects, error: subjectsError } = await supabase
            .from("enrollment_subjects")
            .select("enrollment_subject_id, subject_id, status, final_grade")
            .eq("enrollment_id", enrollment.enrollment_id);

          if (subjectsError) {
            logger.error("Subjects fetch failed", {
              error: subjectsError.message,
              enrollment_id: enrollment.enrollment_id,
            });
            enrollment.subjects = [];
          } else {
            enrollment.subjects = subjects || [];

            for (let subject of enrollment.subjects) {
              const { data: courseSubject, error: csError } = await supabase
                .from("course_subjects")
                .select("subject_code, subject_name, units, year_level")
                .eq("subject_id", subject.subject_id)
                .single();
              if (!csError) {
                subject.course_subject = courseSubject;
              }
            }
          }
        }
      }

      res.status(200).json({
        success: true,
        message: `Enrollment fetched successfully (${responseData.length} record(s))`,
        data: responseData,
      });

      logger.info("Enrollment fetch completed", {
        student_id,
        enrollment_count: responseData.length,
      });
    } catch (err) {
      logger.error("Unexpected error in enrollment fetch", {
        error: err.message,
        stack: err.stack,
        student_id,
      });
      console.error("Full error details:", err);
      res.status(500).json({
        error: "Internal server error",
        details: err.message,
      });
    }
  });

  // ============================================
  // GET /enrollments - Get all enrollments
  // ============================================
  router.get("/", async (req, res) => {
    try {
      console.log("GET /enrollments: Starting request...");

      const { data, error } = await supabase.from("enrollments").select(`
        *,
        enrollment_subjects (
          enrollment_subject_id,
          subject_id,
          final_grade,
          status,
          course_subjects (
            subject_id,
            subject_code,
            subject_name
          )
        )
      `);

      console.log("Query finished. Data length:", data ? data.length : 0);

      if (error) {
        console.error("Supabase error details:", error);
        return res.status(400).json({ error: error.message, code: error.code });
      }

      res.json(data || []);
    } catch (err) {
      console.error("Full fetch error:", {
        message: err.message,
        stack: err.stack,
        name: err.name,
      });
      res.status(500).json({
        error:
          "Fetch failed - check Supabase config, network, or project status",
        details: err.message,
      });
    }
  });

  // ============================================
  // ✅ FIXED: POST /enrollments - Create enrollment with auto year level
  // ============================================
  router.post("/", validateEnrollmentPeriod, async (req, res) => {
    const { student_id, program_id, scheme_id, semester_id, subjects } = req.body;

    const parsedProgramId = parseInt(program_id, 10);
    const parsedSchemeId = parseInt(scheme_id, 10);
    const parsedSemesterId = parseInt(semester_id, 10);

    if (
      !student_id ||
      isNaN(parsedProgramId) ||
      isNaN(parsedSchemeId) ||
      isNaN(parsedSemesterId)
    ) {
      return res.status(400).json({
        error: "student_id, program_id, scheme_id, and semester_id are required and must be valid",
      });
    }

    try {
      const activePeriod = req.enrollmentPeriod;

      if (activePeriod.semester_id !== parsedSemesterId) {
        return res.status(400).json({
          error:
            "Selected semester does not match the active enrollment period",
          active_semester_id: activePeriod.semester_id,
        });
      }

      // ✅ AUTO-CALCULATE the correct year level
      logger.info("Auto-calculating correct year level for enrollment", {
        student_id,
        semester_id: parsedSemesterId,
      });

      const yearLevelResult = await determineCorrectYearLevel(
        supabase,
        logger,
        student_id,
        parsedSemesterId
      );

      const correctYearLevel = yearLevelResult.yearLevel;

      logger.info("Calculated year level for new enrollment", {
        student_id,
        correctYearLevel,
        progressionType: yearLevelResult.progressionType,
        isNewStudent: yearLevelResult.isNewStudent,
      });

      // ✅ Check existing enrollment for this semester AND calculated year level
      const { data: existingCheck, error: existingError } = await supabase
        .from("enrollments")
        .select("enrollment_id, status, year_level")
        .eq("student_id", student_id)
        .eq("semester_id", parsedSemesterId)
        .eq("year_level", correctYearLevel)
        .in("status", ["Pending", "Enrolled", "Validated"])
        .maybeSingle();

      if (existingCheck) {
        return res.status(400).json({
          error: `You are already enrolled for this semester in Year ${correctYearLevel}`,
          reason: "already_enrolled",
          existing_enrollment_id: existingCheck.enrollment_id,
          yearLevel: correctYearLevel,
        });
      }

      // Call RPC for prerequisite validation
      const { data: eligibility, error: eligibilityError } = await supabase.rpc(
        "can_enroll_in_semester_enhanced_v2",
        {
          p_student_id: student_id,
          p_semester_id: parsedSemesterId,
        }
      );

      if (eligibilityError) {
        logger.error("Error checking enrollment eligibility", {
          error: eligibilityError.message,
        });
        return res.status(500).json({
          error: "Failed to validate enrollment eligibility",
          details: eligibilityError.message,
        });
      }

      const eligibilityCheck = eligibility[0];

      logger.info("Enrollment eligibility check result", {
        can_enroll: eligibilityCheck.can_enroll,
        reason: eligibilityCheck.reason,
        message: eligibilityCheck.message,
        prerequisite_details: eligibilityCheck.prerequisite_details,
      });

      if (
        !eligibilityCheck.can_enroll &&
        eligibilityCheck.reason === "incomplete_prerequisites"
      ) {
        return res.status(400).json({
          error: eligibilityCheck.message,
          reason: eligibilityCheck.reason,
          prerequisiteDetails: eligibilityCheck.prerequisite_details,
          missing_subjects:
            eligibilityCheck.prerequisite_details?.missing_subjects || [],
          yearLevel: correctYearLevel,
        });
      }

      if (!eligibilityCheck.can_enroll) {
        return res.status(400).json({
          error: eligibilityCheck.message,
          reason: eligibilityCheck.reason,
          existing_enrollment_id: eligibilityCheck.existing_enrollment_id,
          yearLevel: correctYearLevel,
        });
      }

      // ✅ CREATE ENROLLMENT with auto-calculated year_level
      logger.info("Creating enrollment record with auto-calculated year level", {
        student_id,
        program_id: parsedProgramId,
        scheme_id: parsedSchemeId,
        semester_id: parsedSemesterId,
        year_level: correctYearLevel,
        progression_type: yearLevelResult.progressionType,
      });

      const { data: enrollment, error: enrollmentError } = await supabase
        .from("enrollments")
        .insert([
          {
            student_id,
            program_id: parsedProgramId,
            scheme_id: parsedSchemeId,
            semester_id: parsedSemesterId,
            period_id: activePeriod.period_id,
            year_level: correctYearLevel, // ✅ Using auto-calculated year level
            status: "Pending",
            payment_status: "Unpaid",
          },
        ])
        .select()
        .single();

      if (enrollmentError) {
        logger.error("Error creating enrollment", {
          error: enrollmentError.message,
        });
        return res.status(500).json({
          error: "Failed to create enrollment",
          details: enrollmentError.message,
        });
      }

      logger.info("Enrollment created successfully", {
        enrollment_id: enrollment.enrollment_id,
        year_level: enrollment.year_level,
        progression_info: yearLevelResult,
      });

      // ✅ UPDATE STUDENTS TABLE with current year level
      const { error: studentUpdateError } = await supabase
        .from("students")
        .update({ year_level: correctYearLevel })
        .eq("student_id", student_id);

      if (studentUpdateError) {
        logger.warn("Failed to update student year_level in students table", {
          error: studentUpdateError.message,
          student_id,
          year_level: correctYearLevel,
        });
        // Don't fail the enrollment, just log the warning
      } else {
        logger.info("Updated student year_level in students table", {
          student_id,
          year_level: correctYearLevel,
        });
      }

      // CREATE ENROLLMENT SUBJECTS
      if (subjects && subjects.length > 0) {
        logger.info("Creating enrollment subjects", {
          enrollment_id: enrollment.enrollment_id,
          subject_count: subjects.length,
        });

        const enrollmentSubjects = subjects.map((s) => ({
          enrollment_id: enrollment.enrollment_id,
          subject_id: parseInt(s.subject_id),
          status: "Enrolled",
        }));

        const { error: subjectsError } = await supabase
          .from("enrollment_subjects")
          .insert(enrollmentSubjects);

        if (subjectsError) {
          logger.error("Error creating enrollment subjects", {
            error: subjectsError.message,
          });
          return res.status(500).json({
            error: "Enrollment created but failed to add subjects",
            details: subjectsError.message,
            enrollment_id: enrollment.enrollment_id,
          });
        }

        logger.info("Enrollment subjects created successfully");
      }

      res.status(201).json({
        success: true,
        enrollment_id: enrollment.enrollment_id,
        year_level: correctYearLevel,
        yearLevelInfo: yearLevelResult,
        message: `Enrollment created successfully for Year ${correctYearLevel}`,
      });
    } catch (err) {
      logger.error("Unexpected error in enrollment creation", {
        error: err.message,
        stack: err.stack,
      });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ============================================
  // GET /enrollments/history/:student_id
  // ============================================
  router.get("/history/:student_id", async (req, res) => {
    try {
      const { student_id } = req.params;

      logger.info("Fetching semester history", { student_id });

      const { data, error } = await supabase.rpc(
        "get_student_semester_history",
        {
          p_student_id: student_id,
        }
      );

      if (error) {
        logger.error("Error fetching semester history", {
          error: error.message,
        });
        return res.status(500).json({
          error: "Failed to fetch semester history",
          details: error.message,
        });
      }

      res.json({
        success: true,
        student_id,
        history: data || [],
        total_enrollments: data?.length || 0,
      });
    } catch (err) {
      logger.error("Error in semester history endpoint", {
        error: err.message,
        stack: err.stack,
      });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ============================================
  // GET /enrollments/completion/:enrollment_id
  // ============================================
  router.get("/completion/:enrollment_id", async (req, res) => {
    try {
      const { enrollment_id } = req.params;

      logger.info("Checking enrollment completion", { enrollment_id });

      const { data, error } = await supabase.rpc(
        "check_enrollment_completion",
        {
          p_enrollment_id: parseInt(enrollment_id),
        }
      );

      if (error) {
        logger.error("Error checking enrollment completion", {
          error: error.message,
        });
        return res.status(500).json({
          error: "Failed to check enrollment completion",
          details: error.message,
        });
      }

      const completion = data[0];

      const { data: percentage, error: percentageError } = await supabase.rpc(
        "get_enrollment_completion_percentage",
        {
          p_enrollment_id: parseInt(enrollment_id),
        }
      );

      res.json({
        success: true,
        enrollment_id: parseInt(enrollment_id),
        completion: {
          ...completion,
          completion_percentage: percentage || 0,
        },
      });
    } catch (err) {
      logger.error("Error in completion check endpoint", {
        error: err.message,
        stack: err.stack,
      });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/:id/subjects", async (req, res) => {
    const enrollment_id = parseInt(req.params.id, 10);
    const { subject_id } = req.body;

    if (!enrollment_id || !subject_id) {
      return res
        .status(400)
        .json({ error: "enrollment_id and subject_id required" });
    }

    try {
      const { count, error: countError } = await supabase
        .from("enrollment_subjects")
        .select("*", { count: "exact", head: true })
        .eq("enrollment_id", enrollment_id)
        .eq("is_additional", true);

      if (countError) throw countError;

      if (count >= 3) {
        return res
          .status(400)
          .json({ error: "Maximum of 3 additional subjects reached" });
      }

      const { data, error } = await supabase
        .from("enrollment_subjects")
        .insert([
          {
            enrollment_id,
            subject_id,
            is_additional: true,
            status: "Enrolled",
          },
        ])
        .select()
        .single();

      if (error) throw error;

      res.json(data);
    } catch (err) {
      console.error("Error adding subject:", err);
      res.status(500).json({ error: err.message });
    }
  });

  router.delete("/:id/subjects/:subjectId", async (req, res) => {
    const enrollment_id = parseInt(req.params.id, 10);
    const subject_id = parseInt(req.params.subjectId, 10);

    try {
      const { error } = await supabase
        .from("enrollment_subjects")
        .delete()
        .eq("enrollment_id", enrollment_id)
        .eq("subject_id", subject_id);

      if (error) throw error;

      res.json({ success: true, message: "Subject removed successfully" });
    } catch (err) {
      console.error("Error removing subject:", err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = createEnrollmentRouter;
module.exports.createEnrollmentPeriodsRouter = createEnrollmentPeriodsRouter;
module.exports.createValidateEnrollmentPeriod = createValidateEnrollmentPeriod;