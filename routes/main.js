const express = require("express");

function createMainRouter(supabase, logger) {
  const router = express.Router();

  // NEW ENDPOINT: Check if user email exists in form responses
  router.get("/check-registration", async (req, res) => {
    try {
      const { email } = req.query;

      if (!email) {
        return res.status(400).json({ error: "Email parameter is required" });
      }

      console.log("Checking registration for email:", email);

      const { data, error } = await supabase
        .from("form_responses")
        .select("email")
        .eq("email", email.toLowerCase())
        .limit(1);

      if (error) {
        console.error("Database error:", error);
        throw error;
      }

      console.log("Database query result:", {
        data,
        exists: data && data.length > 0,
      });

      res.json({
        exists: data && data.length > 0,
        email: email,
      });
    } catch (err) {
      console.error("Server error in check-registration:", err.message);
      res.status(500).json({
        error: "Failed to check registration status",
        details: err.message,
      });
    }
  });

  // Get user details by email (for applicants from form_responses)
  router.get("/user-details", async (req, res) => {
    try {
      const { email } = req.query;

      if (!email) {
        return res.status(400).json({ error: "Email parameter is required" });
      }

      const { data, error } = await supabase
        .from("form_responses")
        .select(
          `
        firstname,
        lastname,
        middlename,
        suffix,
        birth_date,
        age,
        birth_place,
        gender,
        citizenship,
        civilstatus,
        religion, 
        ethnicity,
        last_school_attended,
        strand_taken,
        school_address,
        school_type,
        year_graduated,
        father,
        father_occupation,
        mother,
        mother_occupation,
        timestamp,
        parent_number,
        family_income,
        email,
        mobile_number,
        preferred_course,
        admission_id,
        preferred_course, 
        alter_course_1, 
        alter_course_2,
        street,
        baranggay,
        municipality, 
        province,
        home_address
      `
        )
        .eq("email", email.toLowerCase())
        .limit(1);

      if (error) throw error;

      if (data && data.length > 0) {
        res.json({
          exists: true,
          user: data[0],
        });
      } else {
        res.json({
          exists: false,
          message: "User not found in registration database",
        });
      }
    } catch (err) {
      console.error("Server error in user-details:", err.message);
      res.status(500).json({
        error: "Failed to fetch user details",
        details: err.message,
      });
    }
  });

  // Get student profile by email (for enrolled students) - Enhanced with manual fetches
  router.get("/student-profile", async (req, res) => {
    try {
      const { email, enrollment_id, include_subjects = "true" } = req.query;

      if (!email) {
        return res.status(400).json({ error: "Email parameter is required" });
      }

      logger.info("Fetching student profile", {
        email: email.toLowerCase().trim(),
        enrollment_id: enrollment_id ? parseInt(enrollment_id) : null,
        include_subjects,
      });

      // Step 1: Fetch core student data (manual, no joins)
      const { data: studentData, error: studentError } = await supabase
        .from("students")
        .select(
          "student_id, user_id, first_name, last_name, dob, email, program_id, department_id, year_level, admission_year, created_at"
        )
        .eq("email", email.toLowerCase().trim())
        .single(); // Use .single() for one student

      if (studentError) {
        logger.error("Error fetching student", {
          error: studentError.message,
          email,
        });
        throw studentError;
      }

      if (!studentData) {
        logger.warn("Student not found", { email });
        return res.json({
          exists: false,
          message: "Student not found in database",
        });
      }

      const student = studentData;
      logger.info("Student record found", { student_id: student.student_id });

      // Step 1.1: Fetch user details (username)
      const { data: user, error: userError } = await supabase
        .from("users")
        .select("username")
        .eq("user_id", student.user_id)
        .single();

      if (userError && userError.code !== "PGRST116") {
        logger.warn("User fetch failed", {
          error: userError.message,
          user_id: student.user_id,
        });
      }
      const username = user?.username || null;

      // Step 1.2: Fetch program details
      let program = null;
      if (student.program_id) {
        const { data: programData, error: programError } = await supabase
          .from("programs")
          .select("program_id, program_code, program_name, department_id")
          .eq("program_id", student.program_id)
          .single();

        if (programError && programError.code !== "PGRST116") {
          logger.warn("Program fetch failed", {
            error: programError.message,
            program_id: student.program_id,
          });
        } else if (programData) {
          program = programData;

          // Nested: Fetch department
          if (program.department_id) {
            const { data: deptData, error: deptError } = await supabase
              .from("departments")
              .select("department_id, department_code, department_name")
              .eq("department_id", program.department_id)
              .single();
            if (!deptError && deptData) {
              program.department = deptData; // Enrich program with department
            }
          }
        }
      }

      // Step 2: Fetch latest/specific enrollment data (manual fetches)
      let enrollmentQuery = supabase
        .from("enrollments")
        .select(
          "enrollment_id, student_id, program_id, scheme_id, semester_id, status, created_at"
        )
        .eq("student_id", student.student_id)
        .order("created_at", { ascending: false });

      if (enrollment_id) {
        enrollmentQuery = enrollmentQuery.eq(
          "enrollment_id",
          parseInt(enrollment_id)
        );
      }

      const { data: enrollmentRows, error: enrollmentError } =
        await enrollmentQuery.limit(1);

      if (enrollmentError && enrollmentError.code !== "PGRST116") {
        logger.error("Error fetching enrollment", { error: enrollmentError });
        throw enrollmentError;
      }

      const enrollmentCore =
        enrollmentRows && enrollmentRows.length > 0 ? enrollmentRows[0] : null;

      let enrollmentData = null;
      if (enrollmentCore) {
        // Manual: Fetch semester
        let semester = null;
        if (enrollmentCore.semester_id) {
          const { data: semData, error: semError } = await supabase
            .from("semesters")
            .select("semester_id, semester_name, school_year")
            .eq("semester_id", enrollmentCore.semester_id)
            .single();
          if (!semError && semData) semester = semData;
        }

        // Manual: Fetch tuition scheme
        let tuitionScheme = null;
        if (enrollmentCore.scheme_id) {
          const { data: schemeData, error: schemeError } = await supabase
            .from("tuition_schemes")
            .select("scheme_id, scheme_name, amount")
            .eq("scheme_id", enrollmentCore.scheme_id)
            .single();
          if (!schemeError && schemeData) tuitionScheme = schemeData;
        }

        enrollmentData = {
          ...enrollmentCore,
          semester,
          tuition_schemes: tuitionScheme, // Matches original join naming
        };
      }

      logger.info("Enrollment checked", {
        student_id: student.student_id,
        has_enrollment: !!enrollmentData,
      });

      // Step 3: Fetch account data
      const { data: accountData, error: accountError } = await supabase
        .from("accounts")
        .select("account_id, total_balance, last_updated")
        .eq("student_id", student.student_id)
        .single();

      if (accountError && accountError.code !== "PGRST116") {
        logger.error("Error fetching account", { error: accountError });
      }

      const account = accountData || null;

      // Step 4: Fetch enrolled subjects (manual, optional) - Only currently enrolled (status = 'Enrolled')
      // FIXED: Updated select to use midterm_grade and final_grade instead of the dropped 'grade' column
      let enrolledSubjects = [];
      if (enrollmentData && include_subjects === "true") {
        const { data: subjectsData, error: subjectsError } = await supabase
          .from("enrollment_subjects")
          .select(
            "enrollment_subject_id, subject_id, midterm_grade, final_grade, status"
          ) // CHANGED: Removed 'grade', added new columns
          .eq("enrollment_id", enrollmentData.enrollment_id)
          .eq("status", "Enrolled"); // Filter to only currently enrolled subjects

        if (!subjectsError && subjectsData) {
          // Manual: Enrich each subject with course_subjects details
          for (let sub of subjectsData) {
            const { data: courseSub, error: csError } = await supabase
              .from("course_subjects")
              .select(
                "subject_id, subject_code, subject_name, units, year_level"
              )
              .eq("subject_id", sub.subject_id)
              .single();
            if (!csError && courseSub) {
              sub.course_subjects = courseSub; // Matches original join naming
            }
          }
          enrolledSubjects = subjectsData;
        } else if (subjectsError) {
          logger.error("Error fetching enrolled subjects", {
            error: subjectsError,
          });
        }
      }

      // Step 5: Construct final response (matches original structure)
      const response = {
        success: true, // Added for consistency
        exists: true,
        student: {
          student_id: student.student_id,
          user_id: student.user_id,
          first_name: student.first_name,
          last_name: student.last_name,
          dob: student.dob,
          email: student.email,
          username: username,
          year_level: student.year_level,
          admission_year: student.admission_year,
          created_at: student.created_at,

          // Program info (manual)
          program: program
            ? {
                program_id: program.program_id,
                program_code: program.program_code,
                program_name: program.program_name,
                department: program.department, // Enriched
              }
            : null,

          // Department info (now under program, but kept for compatibility)
          department: program?.department || null,

          // Enrollment info (manual)
          enrollment: enrollmentData
            ? {
                enrollment_id: enrollmentData.enrollment_id,
                status: enrollmentData.status,
                semester: enrollmentData.semester
                  ? {
                      semester_id: enrollmentData.semester.semester_id,
                      semester_name: enrollmentData.semester.semester_name,
                      school_year: enrollmentData.semester.school_year,
                    }
                  : null,
                tuition_scheme: enrollmentData.tuition_schemes
                  ? {
                      scheme_id: enrollmentData.tuition_schemes.scheme_id,
                      scheme_name: enrollmentData.tuition_schemes.scheme_name,
                      amount: enrollmentData.tuition_schemes.amount,
                    }
                  : null,
                subjects: enrolledSubjects,
              }
            : null,

          // Account info
          account: account
            ? {
                account_id: account.account_id,
                total_balance: account.total_balance,
                last_updated: account.last_updated,
              }
            : null,
        },
      };

      logger.info("Student profile fetched successfully", {
        student_id: student.student_id,
        email: student.email,
        has_enrollment: !!enrollmentData,
        subjects_count: enrolledSubjects.length,
      });

      res.json(response);
    } catch (err) {
      logger.error("Server error in student-profile:", {
        error: err.message,
        stack: err.stack,
      });
      res.status(500).json({
        error: "Failed to fetch student profile",
        details: err.message,
      });
    }
  });

  router.get("/next-subjects", async (req, res) => {
    try {
      const { student_id, email } = req.query;

      if (!student_id && !email) {
        return res.status(400).json({
          error: "Either student_id or email parameter is required",
        });
      }

      logger.info("Fetching next available subjects", { student_id, email });

      // Step 1: Get student info
      let studentQuery = supabase
        .from("students")
        .select("student_id, program_id, year_level, first_name, last_name");

      if (email) {
        studentQuery = studentQuery.eq("email", email.toLowerCase().trim());
      } else {
        studentQuery = studentQuery.eq("student_id", student_id);
      }

      const { data: student, error: studentError } =
        await studentQuery.single();

      if (studentError || !student) {
        return res.status(404).json({
          error: "Student not found",
          details: studentError?.message,
        });
      }

      logger.info("Student found", { student_id: student.student_id });

      // Step 2: Get passed subjects with their year levels
      const { data: passedSubjects, error: passedError } = await supabase
        .from("enrollment_subjects")
        .select(
          `
        subject_id,
        final_grade,
        enrollment_id,
        enrollments!inner(student_id, semester_id),
        course_subjects!inner(subject_id, year_level, semester_id)
      `
        )
        .eq("enrollments.student_id", student.student_id)
        .not("final_grade", "is", null)
        .lte("final_grade", 3.0);

      logger.info("Passed subjects query result", {
        count: passedSubjects?.length || 0,
        error: passedError?.message,
      });

      const passedSubjectIds = passedSubjects?.map((s) => s.subject_id) || [];

      // **NEW: Step 2.5 - Calculate eligible year level based on completed subjects**
      let eligibleYearLevel = student.year_level;

      if (passedSubjects && passedSubjects.length > 0) {
        // Get all subjects for the student's program grouped by year level
        const { data: programSubjects } = await supabase
          .from("course_subjects")
          .select("subject_id, year_level")
          .eq("program_id", student.program_id)
          .order("year_level", { ascending: true });

        if (programSubjects) {
          // Group subjects by year level
          const subjectsByYear = {};
          programSubjects.forEach((subject) => {
            if (!subjectsByYear[subject.year_level]) {
              subjectsByYear[subject.year_level] = [];
            }
            subjectsByYear[subject.year_level].push(subject.subject_id);
          });

          // Find the highest year level where ALL subjects are completed
          let highestCompletedYear = 0;
          for (const [yearLevel, subjectIds] of Object.entries(
            subjectsByYear
          )) {
            const year = parseInt(yearLevel);
            const allCompleted = subjectIds.every((id) =>
              passedSubjectIds.includes(id)
            );

            if (allCompleted && year > highestCompletedYear) {
              highestCompletedYear = year;
            }
          }

          // If student completed all subjects of their current year or higher, advance them
          if (highestCompletedYear >= student.year_level) {
            eligibleYearLevel = highestCompletedYear + 1;
            logger.info("✓ Student eligible for next year level", {
              completed_year: highestCompletedYear,
              eligible_year: eligibleYearLevel,
            });
          }
        }
      }

      // Step 3: Get the most recent completed enrollment
      let lastCompletedEnrollment = null;

      if (passedSubjects && passedSubjects.length > 0) {
        const enrollmentIds = [
          ...new Set(passedSubjects.map((s) => s.enrollment_id)),
        ];

        const { data: recentEnrollment, error: enrollmentError } =
          await supabase
            .from("enrollments")
            .select("enrollment_id, semester_id, student_id, created_at")
            .in("enrollment_id", enrollmentIds)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();

        if (enrollmentError) {
          logger.error("Error fetching enrollment", { error: enrollmentError });
        }

        lastCompletedEnrollment = recentEnrollment;
      }

      // Step 4: Determine next semester
      let nextSemester = null;
      let nextYearLevel = eligibleYearLevel; // **CHANGED: Use calculated eligible year level**
      let nextSemesterId = null;

      if (lastCompletedEnrollment?.semester_id) {
        const { data: currentSemesterInfo, error: semError } = await supabase
          .from("semesters")
          .select("semester_id, semester_name, school_year")
          .eq("semester_id", lastCompletedEnrollment.semester_id)
          .single();

        logger.info("Current semester info", {
          semester: currentSemesterInfo,
          error: semError?.message,
        });

        if (currentSemesterInfo) {
          if (currentSemesterInfo.semester_name === "1st Semester") {
            // Next: 2nd Semester (same year level, same school year)
            const { data: secondSemester } = await supabase
              .from("semesters")
              .select("semester_id, semester_name, school_year")
              .eq("semester_name", "2nd Semester")
              .eq("school_year", currentSemesterInfo.school_year)
              .maybeSingle();

            if (secondSemester) {
              nextSemester = secondSemester;
              nextSemesterId = secondSemester.semester_id;
              logger.info("✓ Next: 2nd Semester", {
                semester_id: nextSemesterId,
                year_level: nextYearLevel,
              });
            }
          } else if (currentSemesterInfo.semester_name === "2nd Semester") {
            // Check for summer first
            const { data: summerSemester } = await supabase
              .from("semesters")
              .select("semester_id, semester_name, school_year")
              .eq("semester_name", "Summer")
              .eq("school_year", currentSemesterInfo.school_year)
              .maybeSingle();

            if (summerSemester) {
              nextSemester = summerSemester;
              nextSemesterId = summerSemester.semester_id;
            } else {
              // No summer, go to next year's 1st semester
              const { data: nextYearFirstSem } = await supabase
                .from("semesters")
                .select("semester_id, semester_name, school_year")
                .eq("semester_name", "1st Semester")
                .gt("school_year", currentSemesterInfo.school_year)
                .order("school_year", { ascending: true })
                .limit(1)
                .maybeSingle();

              if (nextYearFirstSem) {
                nextSemester = nextYearFirstSem;
                nextSemesterId = nextYearFirstSem.semester_id;
                logger.info("✓ Next: New Year 1st Semester", {
                  semester_id: nextSemesterId,
                  year_level: nextYearLevel,
                });
              }
            }
          } else if (currentSemesterInfo.semester_name === "Summer") {
            const { data: nextYearFirstSem } = await supabase
              .from("semesters")
              .select("semester_id, semester_name, school_year")
              .eq("semester_name", "1st Semester")
              .gt("school_year", currentSemesterInfo.school_year)
              .order("school_year", { ascending: true })
              .limit(1)
              .maybeSingle();

            if (nextYearFirstSem) {
              nextSemester = nextYearFirstSem;
              nextSemesterId = nextYearFirstSem.semester_id;
            }
          }
        }
      }

      // Fallback to active enrollment period
      if (!nextSemester) {
        logger.warn("Using active enrollment period fallback");

        const { data: activePeriod } = await supabase
          .from("enrollment_periods")
          .select(
            `
          semester_id,
          semesters(semester_id, semester_name, school_year)
        `
          )
          .eq("is_active", true)
          .limit(1)
          .maybeSingle();

        if (activePeriod?.semesters) {
          nextSemester = activePeriod.semesters;
          nextSemesterId = activePeriod.semester_id;
        }
      }

      if (!nextSemester || !nextSemesterId) {
        return res.status(404).json({
          error: "No next enrollment period found",
        });
      }

      logger.info("Final next semester", {
        semester_id: nextSemesterId,
        semester_name: nextSemester.semester_name,
        year_level: nextYearLevel,
      });

      // Step 5: Get eligible subjects
      const { data: eligibleSubjects, error: subjectsError } =
        await supabase.rpc("get_next_subjects", {
          p_student_id: student.student_id,
        });

      if (subjectsError) {
        logger.error("Error fetching eligible subjects", {
          error: subjectsError,
        });
        throw subjectsError;
      }

      logger.info("Eligible subjects", {
        total: eligibleSubjects?.length || 0,
        by_semester: eligibleSubjects
          ? [...new Set(eligibleSubjects.map((s) => s.semester_id))]
          : [],
      });

      // Step 6: Filter subjects for next semester and year level
      const nextSemesterSubjects =
        eligibleSubjects?.filter(
          (subject) =>
            subject.semester_id === nextSemesterId &&
            subject.year_level === nextYearLevel // **CHANGED: Use calculated year level**
        ) || [];

      logger.info("Filtered for next enrollment", {
        matched: nextSemesterSubjects.length,
        filter: { nextSemesterId, nextYearLevel },
      });

      // Step 6.5: Get instructor information for next semester subjects
      let instructorInfo = {};
      let scheduleInfo = {};

      if (nextSemesterSubjects.length > 0) {
        const subjectIds = nextSemesterSubjects.map((s) => s.subject_id);

        const { data: schedules, error: scheduleError } = await supabase
          .from("course_schedules")
          .select(
            `
          schedule_id,
          subject_id,
          teacher_id,
          day_of_week,
          start_time,
          end_time,
          room,
          batch,
          teachers (
            teacher_id,
            first_name,
            last_name,
            middle_name,
            email,
            specialization
          )
        `
          )
          .in("subject_id", subjectIds)
          .eq("year_level", nextYearLevel)
          .eq("program_id", student.program_id);

        if (scheduleError) {
          logger.error("Error fetching instructor info", {
            error: scheduleError,
          });
        }

        // Map instructor and schedule info by subject_id
        if (schedules) {
          schedules.forEach((schedule) => {
            // Store instructor info
            if (schedule.teachers) {
              if (!instructorInfo[schedule.subject_id]) {
                instructorInfo[schedule.subject_id] = [];
              }

              instructorInfo[schedule.subject_id].push({
                teacher_id: schedule.teachers.teacher_id,
                name: `${schedule.teachers.first_name} ${schedule.teachers.last_name}`,
                full_name: schedule.teachers.middle_name
                  ? `${schedule.teachers.first_name} ${schedule.teachers.middle_name} ${schedule.teachers.last_name}`
                  : `${schedule.teachers.first_name} ${schedule.teachers.last_name}`,
                email: schedule.teachers.email,
                specialization: schedule.teachers.specialization,
              });
            }

            // Store schedule info
            if (!scheduleInfo[schedule.subject_id]) {
              scheduleInfo[schedule.subject_id] = [];
            }

            scheduleInfo[schedule.subject_id].push({
              schedule_id: schedule.schedule_id,
              day_of_week: schedule.day_of_week,
              start_time: schedule.start_time,
              end_time: schedule.end_time,
              room: schedule.room,
              batch: schedule.batch,
            });
          });
        }

        logger.info("Instructor and schedule info loaded", {
          subjects_with_instructors: Object.keys(instructorInfo).length,
          subjects_with_schedules: Object.keys(scheduleInfo).length,
        });
      }

      // Step 7: Get total program subjects
      const { count: totalProgramSubjects } = await supabase
        .from("course_subjects")
        .select("subject_id", { count: "exact", head: true })
        .eq("program_id", student.program_id);

      const completionPercentage = totalProgramSubjects
        ? Math.round((passedSubjectIds.length / totalProgramSubjects) * 100)
        : 0;

      // Step 8: Process subjects
      const processedSubjects = nextSemesterSubjects.map((subject) => ({
        subject_id: subject.subject_id,
        subject_code: subject.subject_code,
        subject_name: subject.subject_name,
        units: subject.units,
        year_level: subject.year_level,
        semester_id: subject.semester_id,
        semester_name: subject.semesters?.semester_name || null,
        subject_type: subject.subject_type,
        is_elective: subject.is_elective,
        prerequisite_id: subject.prerequisite_id,
        prerequisite_satisfied: subject.prerequisite_id
          ? passedSubjectIds.includes(subject.prerequisite_id)
          : true,
        instructors: instructorInfo[subject.subject_id] || [],
        schedules: scheduleInfo[subject.subject_id] || [],
      }));

      const totalUnitsAvailable = processedSubjects.reduce(
        (sum, s) => sum + (s.units || 0),
        0
      );

      res.json({
        success: true,
        student: {
          student_id: student.student_id,
          name: `${student.first_name} ${student.last_name}`,
          current_year_level: student.year_level,
          next_year_level: nextYearLevel, // **This will now show 2 for your student**
          program_id: student.program_id,
        },
        progress: {
          completed_subjects: passedSubjectIds.length,
          total_subjects: totalProgramSubjects,
          completion_percentage: completionPercentage,
        },
        next_enrollment: {
          semester_id: nextSemester.semester_id,
          semester_name: nextSemester.semester_name,
          school_year: nextSemester.school_year,
          year_level: nextYearLevel,
        },
        available_subjects: processedSubjects,
        summary: {
          total_subjects: processedSubjects.length,
          total_units: totalUnitsAvailable,
          subjects_with_unmet_prerequisites: processedSubjects.filter(
            (s) => !s.prerequisite_satisfied
          ).length,
          subjects_with_instructors: processedSubjects.filter(
            (s) => s.instructors.length > 0
          ).length,
          subjects_with_schedules: processedSubjects.filter(
            (s) => s.schedules.length > 0
          ).length,
        },
      });
    } catch (err) {
      logger.error("Error in next-subjects endpoint", {
        error: err.message,
        stack: err.stack,
      });
      res.status(500).json({
        error: "Failed to fetch next subjects",
        details: err.message,
      });
    }
  });

  router.get("/tuition-schemes", async (req, res) => {
    try {
      const { student_id, email, semester_id } = req.query;

      if (!student_id && !email) {
        return res.status(400).json({
          error: "Either student_id or email parameter is required",
        });
      }

      logger.info("Fetching tuition schemes", {
        student_id,
        email,
        semester_id,
      });

      // Step 1: Get student info
      let studentQuery = supabase
        .from("students")
        .select(
          "student_id, program_id, year_level, first_name, last_name, email"
        );

      if (email) {
        studentQuery = studentQuery.eq("email", email.toLowerCase().trim());
      } else {
        studentQuery = studentQuery.eq("student_id", student_id);
      }

      const { data: student, error: studentError } =
        await studentQuery.single();

      if (studentError || !student) {
        return res.status(404).json({
          error: "Student not found",
          details: studentError?.message,
        });
      }

      // **ADD: Step 2 - Calculate eligible year level (SAME AS /next-subjects)**
      const { data: passedSubjects } = await supabase
        .from("enrollment_subjects")
        .select(
          `
        subject_id,
        final_grade,
        enrollment_id,
        enrollments!inner(student_id, semester_id)
      `
        )
        .eq("enrollments.student_id", student.student_id)
        .not("final_grade", "is", null)
        .lte("final_grade", 3.0);

      const passedSubjectIds = passedSubjects?.map((s) => s.subject_id) || [];

      let eligibleYearLevel = student.year_level;

      if (passedSubjects && passedSubjects.length > 0) {
        const { data: programSubjects } = await supabase
          .from("course_subjects")
          .select("subject_id, year_level")
          .eq("program_id", student.program_id)
          .order("year_level", { ascending: true });

        if (programSubjects) {
          const subjectsByYear = {};
          programSubjects.forEach((subject) => {
            if (!subjectsByYear[subject.year_level]) {
              subjectsByYear[subject.year_level] = [];
            }
            subjectsByYear[subject.year_level].push(subject.subject_id);
          });

          let highestCompletedYear = 0;
          for (const [yearLevel, subjectIds] of Object.entries(
            subjectsByYear
          )) {
            const year = parseInt(yearLevel);
            const allCompleted = subjectIds.every((id) =>
              passedSubjectIds.includes(id)
            );

            if (allCompleted && year > highestCompletedYear) {
              highestCompletedYear = year;
            }
          }

          if (highestCompletedYear >= student.year_level) {
            eligibleYearLevel = highestCompletedYear + 1;
            logger.info("✓ Student eligible for next year level schemes", {
              completed_year: highestCompletedYear,
              eligible_year: eligibleYearLevel,
            });
          }
        }
      }

      // Step 3: Get semester info
      let targetSemesterId = semester_id;
      let semesterInfo = null;

      if (!targetSemesterId) {
        // Find active enrollment period
        const { data: activePeriod } = await supabase
          .from("enrollment_periods")
          .select(
            `
          semester_id,
          semesters(semester_id, semester_name, school_year)
        `
          )
          .eq("is_active", true)
          .limit(1)
          .maybeSingle();

        if (activePeriod?.semesters) {
          targetSemesterId = activePeriod.semester_id;
          semesterInfo = activePeriod.semesters;
        }
      } else {
        const { data: semester } = await supabase
          .from("semesters")
          .select("semester_id, semester_name, school_year")
          .eq("semester_id", targetSemesterId)
          .single();

        semesterInfo = semester;
      }

      if (!semesterInfo) {
        return res.status(404).json({
          error: "No active enrollment period found",
        });
      }

      // **CHANGED: Step 4 - Fetch schemes using eligible year level**
      const { data: schemes, error: schemesError } = await supabase
        .from("tuition_schemes")
        .select("*")
        .eq("program_id", student.program_id)
        .eq("year", eligibleYearLevel) // **Use calculated year level**
        .eq("semester_id", targetSemesterId)
        .order("amount", { ascending: true });

      if (schemesError) {
        logger.error("Error fetching tuition schemes", { error: schemesError });
        return res.status(500).json({
          error: "Failed to fetch tuition schemes",
          details: schemesError.message,
        });
      }

      if (!schemes || schemes.length === 0) {
        return res.status(404).json({
          success: false,
          error: "No tuition schemes found",
          message: `No schemes available for Year ${eligibleYearLevel}, ${semesterInfo.semester_name}`,
          student: {
            student_id: student.student_id,
            current_year_level: student.year_level,
            eligible_year_level: eligibleYearLevel,
          },
        });
      }

      // Step 5: Get program details
      const { data: program } = await supabase
        .from("programs")
        .select("program_id, program_code, program_name")
        .eq("program_id", student.program_id)
        .single();

      // Step 6: Format schemes
      const formattedSchemes = {
        full_payment: null,
        installment_scheme_1: null,
        installment_scheme_2: null,
      };

      schemes.forEach((scheme) => {
        const schemeData = {
          scheme_id: scheme.scheme_id,
          scheme_name: scheme.scheme_name,
          scheme_type: scheme.scheme_type,
          amount: parseFloat(scheme.amount),
          discount: parseFloat(scheme.discount || 0),
          final_amount:
            parseFloat(scheme.amount) - parseFloat(scheme.discount || 0),
          year_level: scheme.year, // This will now be the eligible year level
        };

        if (scheme.scheme_type === "cash") {
          formattedSchemes.full_payment = schemeData;
        } else if (scheme.scheme_type === "installment") {
          schemeData.downpayment = parseFloat(scheme.downpayment || 0);
          schemeData.monthly_payment = parseFloat(scheme.monthly_payment || 0);
          schemeData.months = parseInt(scheme.months || 0);
          schemeData.total_amount = parseFloat(scheme.amount);

          if (!formattedSchemes.installment_scheme_1) {
            formattedSchemes.installment_scheme_1 = schemeData;
          } else if (!formattedSchemes.installment_scheme_2) {
            formattedSchemes.installment_scheme_2 = schemeData;
          }
        }
      });

      const availableSchemes = Object.keys(formattedSchemes).filter(
        (key) => formattedSchemes[key] !== null
      );

      res.json({
        success: true,
        lookup_mode: "dynamic",
        student: {
          student_id: student.student_id,
          name: `${student.first_name} ${student.last_name}`,
          email: student.email,
          current_year_level: student.year_level,
          eligible_year_level: eligibleYearLevel, // **Show calculated level**
        },
        program: {
          program_id: program.program_id,
          program_code: program.program_code,
          program_name: program.program_name,
        },
        semester: {
          semester_id: semesterInfo.semester_id,
          semester_name: semesterInfo.semester_name,
          school_year: semesterInfo.school_year,
        },
        target_year_level: eligibleYearLevel, // **Use calculated level**
        schemes: formattedSchemes,
        available_schemes: availableSchemes,
        total_schemes_available: availableSchemes.length,
      });
    } catch (err) {
      logger.error("Error in tuition-schemes endpoint", {
        error: err.message,
        stack: err.stack,
      });
      res.status(500).json({
        error: "Failed to fetch tuition schemes",
        details: err.message,
      });
    }
  });

  // Delete user by email
  router.delete("/user-details", async (req, res) => {
    try {
      const { email } = req.query;

      if (!email) {
        return res.status(400).json({ error: "Email parameter is required" });
      }

      // First, check if the user exists
      const { data: userData, error: checkError } = await supabase
        .from("form_responses")
        .select("email")
        .eq("email", email.toLowerCase())
        .limit(1);

      if (checkError) throw checkError;

      if (!userData || userData.length === 0) {
        return res.status(404).json({
          error: "User not found",
          message: "No user found with the provided email address",
        });
      }

      // Delete the user
      const { data, error } = await supabase
        .from("form_responses")
        .delete()
        .eq("email", email.toLowerCase());

      if (error) throw error;

      res.json({
        success: true,
        message: "User successfully deleted",
        deleted_email: email.toLowerCase(),
      });
    } catch (err) {
      console.error("Server error in user deletion:", err.message);
      res.status(500).json({
        error: "Failed to delete user",
        details: err.message,
      });
    }
  });

  // Avoid favicon 404 noise
  router.get("/favicon.ico", (req, res) => res.status(204).end());

  return router;
}

module.exports = createMainRouter;
