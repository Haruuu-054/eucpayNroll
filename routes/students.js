const express = require("express");
const bcrypt = require("bcrypt");

function createStudentsRouter(supabase, logger) {
  const router = express.Router();

  router.post("/", async (req, res) => {
    const {
      email,
      student_id,
      first_name,
      last_name,
      dob,
      program_id,
      department_id,
      year_level,
      admission_year,
      semester_id,
      scheme_id: providedSchemeId,
    } = req.body;

    logger.info("Starting student creation process", {
      student_id,
      email,
      program_id,
      year_level,
      semester_id,
      providedSchemeId,
    });

    // Validate required fields (scheme_id is optional now)
    if (
      !email ||
      !student_id ||
      !first_name ||
      !last_name ||
      !dob ||
      !program_id ||
      !department_id ||
      !year_level ||
      !admission_year ||
      !semester_id
    ) {
      logger.error("Missing required fields in student creation request", {
        body: req.body,
      });
      return res.status(400).json({ error: "Missing required fields" });
    }

    let createdUserId = null;
    let createdStudentId = null;
    let createdAccountId = null;
    let createdEnrollmentId = null;
    let scheme_id = providedSchemeId;

    try {
      // 1. Get role_id for Student
      logger.info("Step 1: Fetching Student role");
      const { data: roleData, error: roleError } = await supabase
        .from("roles")
        .select("role_id")
        .eq("role_name", "Student")
        .single();

      if (roleError || !roleData) {
        logger.error("Student role not found", { error: roleError });
        throw new Error("Student role not found");
      }
      const role_id = roleData.role_id;
      logger.info("Student role found", { role_id });

      // 2. Create user (username = student_id, password = dob formatted)
      logger.info("Step 2: Creating user account");
      const password = formatBirthdate(dob);
      const password_hash = await bcrypt.hash(password, 10);

      const { data: userData, error: userError } = await supabase
        .from("users")
        .insert([
          {
            username: student_id,
            password_hash,
            role_id,
            email,
          },
        ])
        .select()
        .single();

      if (userError) {
        logger.error("Failed to create user", {
          error: userError,
          student_id,
        });
        throw new Error(`Failed to create user: ${userError.message}`);
      }
      createdUserId = userData.user_id;
      logger.info("User created successfully", {
        user_id: createdUserId,
        username: student_id,
      });

      // 3. Create student record
      logger.info("Step 3: Creating student record");
      const { data: studentData, error: studentError } = await supabase
        .from("students")
        .insert([
          {
            student_id,
            user_id: createdUserId,
            first_name,
            last_name,
            dob,
            email,
            program_id,
            department_id,
            year_level,
            admission_year,
          },
        ])
        .select()
        .single();

      if (studentError) {
        logger.error("Failed to create student record", {
          error: studentError,
          student_id,
        });
        throw new Error(
          `Failed to create student record: ${studentError.message}`
        );
      }
      createdStudentId = studentData.student_id;
      logger.info("Student record created successfully", {
        student_id: createdStudentId,
      });

      // 4. Fetch tuition scheme or auto-select fallback
      logger.info("Step 4: Fetching tuition scheme", { scheme_id });
      let { data: schemeData, error: schemeError } = await supabase
        .from("tuition_schemes")
        .select("scheme_id, amount")
        .eq("scheme_id", scheme_id)
        .single();

      // Auto-pick fallback if scheme_id not found or not provided
      if (schemeError || !schemeData) {
        logger.warn("Provided scheme_id not found or invalid. Selecting fallback.", {
          providedSchemeId,
          program_id,
          year_level,
        });

        const { data: fallbackScheme, error: fallbackError } = await supabase
          .from("tuition_schemes")
          .select("scheme_id, amount")
          .eq("program_id", program_id)
          .eq("year", year_level)
          .limit(1)
          .single();

        if (fallbackError || !fallbackScheme) {
          logger.error("No fallback tuition scheme found", {
            fallbackError,
            program_id,
            year_level,
          });
          throw new Error(
            "No valid tuition scheme found for this program and year"
          );
        }

        schemeData = fallbackScheme;
        scheme_id = fallbackScheme.scheme_id;
      }

      const initialBalance = schemeData.amount;
      logger.info("Tuition scheme resolved", {
        scheme_id,
        amount: initialBalance,
      });

      // 5. Create account
      logger.info("Step 5: Creating student account", {
        student_id,
        initial_balance: initialBalance,
      });
      const { data: accountData, error: accountError } = await supabase
        .from("accounts")
        .insert([
          {
            student_id: createdStudentId,
            total_balance: initialBalance,
          },
        ])
        .select()
        .single();

      if (accountError) {
        logger.error("Failed to create account", {
          error: accountError,
          student_id,
        });
        throw new Error(`Failed to create account: ${accountError.message}`);
      }
      createdAccountId = accountData.account_id;
      logger.info("Account created successfully", {
        account_id: createdAccountId,
        total_balance: initialBalance,
      });

      // 6. Create enrollment
      logger.info("Step 6: Creating enrollment", {
        student_id,
        program_id,
        scheme_id,
        semester_id,
      });
      const { data: enrollmentData, error: enrollmentError } = await supabase
        .from("enrollments")
        .insert([
          {
            student_id: createdStudentId,
            program_id,
            scheme_id,
            semester_id,
            status: "Pending",
          },
        ])
        .select()
        .single();

      if (enrollmentError) {
        logger.error("Failed to create enrollment", {
          error: enrollmentError,
          student_id,
        });
        throw new Error(`Failed to create enrollment: ${enrollmentError.message}`);
      }
      createdEnrollmentId = enrollmentData.enrollment_id;
      logger.info("Enrollment created successfully", {
        enrollment_id: createdEnrollmentId,
      });

      // 7. Preload subjects
      logger.info("Step 7: Fetching subjects for enrollment", {
        program_id,
        year_level,
        semester_id,
      });
      const { data: subjects, error: subjectsError } = await supabase
        .from("course_subjects")
        .select("subject_id")
        .eq("program_id", program_id)
        .eq("year_level", year_level)
        .eq("semester_id", semester_id);

      if (subjectsError) {
        logger.error("Failed to fetch subjects", { error: subjectsError });
        throw new Error(`Failed to fetch subjects: ${subjectsError.message}`);
      }

      if (!subjects || subjects.length === 0) {
        logger.error("No subjects found for given criteria", {
          program_id,
          year_level,
          semester_id,
        });
        throw new Error(
          `No subjects found for program ${program_id}, year ${year_level}, semester ${semester_id}`
        );
      }

      logger.info(`Found ${subjects.length} subjects to enroll`);

      // 8. Enroll subjects
      const enrollmentSubjects = subjects.map((subject) => ({
        enrollment_id: createdEnrollmentId,
        subject_id: subject.subject_id,
        status: "Enrolled",
      }));

      const { data: enrolledSubjects, error: enrollSubjectsError } = await supabase
        .from("enrollment_subjects")
        .insert(enrollmentSubjects)
        .select();

      if (enrollSubjectsError) {
        logger.error("Failed to enroll subjects", { error: enrollSubjectsError });
        throw new Error(
          `Failed to enroll subjects: ${enrollSubjectsError.message}`
        );
      }

      logger.info("Subjects enrolled successfully", {
        count: enrolledSubjects.length,
        enrollment_id: createdEnrollmentId,
      });

      // ✅ Success Response
      const response = {
        success: true,
        message: "Student created successfully",
        data: {
          student_id: createdStudentId,
          user_id: createdUserId,
          account_id: createdAccountId,
          enrollment_id: createdEnrollmentId,
          scheme_id,
          initial_balance: initialBalance,
          subjects_loaded: enrolledSubjects.length,
        },
      };

      logger.info("Student creation completed successfully", response.data);
      res.status(201).json(response);
    } catch (err) {
      logger.error("Error in student creation process", {
        error: err.message,
        stack: err.stack,
        student_id,
      });
      logger.info("Starting rollback process");

      if (createdEnrollmentId)
        await supabase
          .from("enrollments")
          .delete()
          .eq("enrollment_id", createdEnrollmentId);
      if (createdAccountId)
        await supabase
          .from("accounts")
          .delete()
          .eq("account_id", createdAccountId);
      if (createdStudentId)
        await supabase
          .from("students")
          .delete()
          .eq("student_id", createdStudentId);
      if (createdUserId)
        await supabase.from("users").delete().eq("user_id", createdUserId);

      logger.info("Rollback completed");

      res.status(500).json({
        success: false,
        error: "Failed to create student",
        details: err.message,
      });
    }
  });

  router.get("/", async (req, res) => {
    const { data, error } = await supabase.from("students").select("*");
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  });

  return router;
}

function formatBirthdate(dob) {
  const date = new Date(dob);
  if (isNaN(date)) {
    throw new Error("Invalid date of birth");
  }

  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const yyyy = date.getFullYear();

  return `${mm}-${dd}-${yyyy}`;
}

module.exports = createStudentsRouter;
