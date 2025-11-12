const { createClient } = require("@supabase/supabase-js");
const express = require("express");
const bcrypt = require("bcrypt");
const multer = require("multer");
const XLSX = require("xlsx");

// Configure multer for file uploads - using memory storage
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

function createUsersRouter() {
  const router = express.Router();

  // Regular Supabase client (anon key)
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
  );

  // Admin client with service role key
  const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  );

  // CREATE USER - POST /
  router.post("/", async (req, res) => {
    const { username, password_hash, role_name, email } = req.body;

    if (!username || !password_hash || !role_name || !email) {
      return res.status(400).json({ error: "All fields are required" });
    }

    try {
      // 1. Lookup role_id from roles table
      const { data: roleData, error: roleError } = await supabase
        .from("roles")
        .select("role_id")
        .eq("role_name", role_name)
        .single();

      if (roleError || !roleData) {
        return res.status(400).json({ error: "Invalid role name" });
      }

      const role_id = roleData.role_id;

      // 2. Hash the password for your users table
      const hashedPassword = await bcrypt.hash(password_hash, 10);

      // 3. Create Supabase Auth user (for login capability)
      const { data: authData, error: authError } =
        await supabaseAdmin.auth.admin.createUser({
          email: email,
          password: password_hash, // Plain password for Supabase Auth
          email_confirm: true,
          user_metadata: {
            username: username,
            role_id: role_id,
          },
        });

      if (authError) {
        return res.status(400).json({ error: authError.message });
      }

      // 4. Insert into your custom users table
      const { data, error } = await supabase
        .from("users")
        .insert([
          {
            username: username,
            password_hash: hashedPassword, // Hashed password
            role_id: role_id,
            email: email,
          },
        ])
        .select();

      if (error) {
        // Rollback: Delete auth user if database insert fails
        await supabaseAdmin.auth.admin.deleteUser(authData.user.id);
        return res.status(400).json({ error: error.message });
      }

      res.status(201).json({
        message: "User created successfully",
        user: data[0],
        auth_id: authData.user.id,
      });
    } catch (err) {
      console.error("Error creating user:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET ALL USERS - GET /
  router.get("/", async (req, res) => {
    const { data, error } = await supabase.from("users").select(`
      user_id,
      username,
      email,
      password_hash,
      role_id,
      roles (
        role_name
      )
    `);

    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  });

  router.get('/teachers', async (req, res) => {
    const { data, error } = await supabase
      .from('teachers')
      .select(`
        teacher_id,
        first_name,
        last_name,
        middle_name,
        email,
        department_id,
        specialization,
        users!inner(role_id)
      `)
      .eq('users.role_id', 8);

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    const transformedData = data.map(teacher => ({
      teacher_id: teacher.teacher_id,
      first_name: teacher.first_name,
      last_name: teacher.last_name,
      middle_name: teacher.middle_name,
      email: teacher.email,
      department_id: teacher.department_id,
      specialization: teacher.specialization
    }));

    res.json(transformedData);
  });

  // GET USER BY ID - GET /:id
  router.get("/:id", async (req, res) => {
    const user_id = req.params.id;

    if (!user_id) {
      return res.status(400).json({ error: "Invalid or missing user ID" });
    }

    const { data, error } = await supabase
      .from("users")
      .select(
        `
      user_id,
      username,
      email,
      password_hash,
      role_id,
      roles (
        role_name
      )
    `
      )
      .eq("user_id", user_id)
      .single();

    if (error) {
      if (error.code === "PGRST116") {
        return res.status(404).json({ error: "User not found" });
      }
      return res.status(400).json({ error: error.message });
    }

    res.json(data);
  });

  // UPDATE USER BY ID - PUT /:id
  router.put("/:id", async (req, res) => {
    const { id } = req.params;
    const { username, email, password_hash, role_id } = req.body;

    try {
      const { data, error } = await supabase
        .from("users")
        .update({
          username,
          email,
          password_hash,
          role_id,
        })
        .eq("user_id", id)
        .select();

      if (error) throw error;

      if (!data || data.length === 0) {
        return res.status(404).json({
          success: false,
          error: "User not found",
        });
      }

      res.json({
        success: true,
        message: "User updated successfully",
        data,
      });
    } catch (err) {
      res.status(400).json({
        success: false,
        error: err.message,
      });
    }
  });

  // DELETE USER BY ID - DELETE /:id
  router.delete("/:id", async (req, res) => {
    const { id } = req.params;
    console.log("DELETE user_id:", id);
    try {
      const { error } = await supabase.from("users").delete().eq("user_id", id);

      if (error) throw error;

      res.json({
        success: true,
        message: "User Deleted successfully",
      });
    } catch (err) {
      res.status(400).json({
        success: false,
        error: err.message,
      });
    }
  });

  // BULK CREATE STUDENTS FROM FILE - POST /bulk/students/upload
  router.post(
    "/bulk/students/upload",
    upload.single("file"),
    async (req, res) => {
      try {
        console.log("=== BULK UPLOAD START ===");
        console.log("File received:", req.file ? "Yes" : "No");
        
        if (!req.file) {
          console.error("No file in request");
          return res.status(400).json({ error: "No file uploaded" });
        }

        console.log("File details:", {
          originalname: req.file.originalname,
          mimetype: req.file.mimetype,
          size: req.file.size,
          bufferSize: req.file.buffer ? req.file.buffer.length : 0
        });

        const fileExtension = req.file.originalname
          .split(".")
          .pop()
          .toLowerCase();

        console.log("File extension:", fileExtension);

        let students = [];

        // Parse based on file type - using buffer instead of file path
        if (
          fileExtension === "csv" ||
          fileExtension === "xlsx" ||
          fileExtension === "xls"
        ) {
          console.log("Parsing Excel/CSV from buffer...");
          students = parseExcelOrCSVFromBuffer(req.file.buffer);
          console.log("Parsed students:", students.length);
        } else {
          console.error("Unsupported file format:", fileExtension);
          return res.status(400).json({
            error: "Unsupported file format. Please upload CSV or Excel file.",
          });
        }

        if (students.length === 0) {
          console.error("No valid students found in file");
          return res
            .status(400)
            .json({ error: "No valid student data found in file" });
        }

        console.log(`Processing ${students.length} students from file...`);

        const insertedStudents = [];
        const errors = [];

        // Process students sequentially
        for (let i = 0; i < students.length; i++) {
          const studentData = students[i];
          console.log(`\nProcessing student ${i + 1}/${students.length}:`, {
            name: `${studentData.first_name} ${studentData.last_name}`,
            email: studentData.email
          });
          
          try {
            const result = await processStudentWithDetails(studentData);
            insertedStudents.push(result);
            console.log(`✓ Successfully inserted student ${i + 1}`);
          } catch (error) {
            console.error(`✗ Failed to insert student ${i + 1}:`, error.message);
            errors.push({
              row: studentData._rowNumber || i + 2,
              student: `${studentData.first_name} ${studentData.last_name}`,
              email: studentData.email,
              error: error.message,
            });
          }
        }

        console.log("=== BULK UPLOAD COMPLETE ===");
        console.log("Inserted:", insertedStudents.length);
        console.log("Errors:", errors.length);

        res.status(201).json({
          inserted: insertedStudents.length,
          total: students.length,
          students: insertedStudents,
          errors,
        });
      } catch (error) {
        console.error("=== BULK UPLOAD ERROR ===");
        console.error("Error:", error);
        console.error("Stack:", error.stack);
        res.status(500).json({
          error: "Internal server error during file processing",
          details: error.message,
        });
      }
    }
  );

  // BULK CREATE STUDENTS - POST /bulk/students
  router.post("/bulk/students", async (req, res) => {
    try {
      console.log("Incoming body:", req.body);
      const students = req.body.students;

      // Validate input
      if (!Array.isArray(students) || students.length === 0) {
        return res.status(400).json({
          error: "Request body must contain a non-empty 'students' array",
        });
      }

      const insertedStudents = [];
      const errors = [];

      // Process students sequentially to avoid race conditions
      for (let studentData of students) {
        try {
          const result = await processStudentWithDetails(studentData);
          insertedStudents.push(result);
        } catch (error) {
          errors.push({
            student: `${studentData.first_name} ${studentData.last_name}`,
            email: studentData.email,
            error: error.message,
          });
        }
      }

      res.status(201).json({
        inserted: insertedStudents.length,
        students: insertedStudents,
        errors,
      });
    } catch (error) {
      console.error("Bulk student creation error:", error);
      res.status(500).json({
        error: "Internal server error during bulk student creation",
      });
    }
  });

  // BULK CREATE USERS - POST /bulk (simple user creation)
  router.post("/bulk", async (req, res) => {
    try {
      console.log("Incoming body:", req.body);
      const users = req.body.users;

      // Validate input
      if (!Array.isArray(users) || users.length === 0) {
        return res.status(400).json({
          error: "Request body must contain a non-empty 'users' array",
        });
      }

      // Fetch roles
      const roles = await fetchRoles();
      const roleMap = createRoleMap(roles);

      const insertedUsers = [];
      const errors = [];

      // Process users sequentially to avoid race conditions
      for (let userData of users) {
        try {
          const result = await processUser(userData, roleMap);
          insertedUsers.push(result);
        } catch (error) {
          errors.push({
            username:
              userData.username ||
              `${userData.first_name}.${userData.last_name}`,
            error: error.message,
          });
        }
      }

      res.status(201).json({
        inserted: insertedUsers.length,
        users: insertedUsers,
        errors,
      });
    } catch (error) {
      console.error("Bulk user creation error:", error);
      res.status(500).json({
        error: "Internal server error during bulk user creation",
      });
    }
  });

  // ============ FIXED: Parse from buffer instead of file path ============
  function parseExcelOrCSVFromBuffer(buffer) {
    console.log("Parsing workbook from buffer...");
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    console.log("Workbook sheets:", workbook.SheetNames);
    
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];

    // Convert to JSON
    const rawData = XLSX.utils.sheet_to_json(worksheet, { defval: null });
    console.log("Raw data rows:", rawData.length);
    console.log("First row sample:", rawData[0]);

    // Transform data to match our structure
    const students = rawData.map((row, index) => {
      const dob = parseDate(row["Date of Birth"] || row["dob"]);
      const studentData = {
        _rowNumber: index + 2, // +2 because row 1 is header, index starts at 0
        first_name: row["First Name"] || row["first_name"],
        last_name: row["Last Name"] || row["last_name"],
        email: row["Email"] || row["email"],
        password: row["Password"] || row["password"] || dob || "DefaultPass123!",
        dob: dob,
        program_code: row["Program Code"] || row["program_code"],
        department_code: row["Department Code"] || row["department_code"],
        year_level: parseInt(row["Year Level"] || row["year_level"]),
        admission_year: parseInt(
          row["Admission Year"] || row["admission_year"]
        ),
        total_balance: parseFloat(
          row["Total Balance"] || row["total_balance"] || 0
        ),
        semester_name: row["Semester Name"] || row["semester_name"],
        scheme_name: row["Scheme Name"] || row["scheme_name"],
      };

      // Optional: Include student_id if provided
      if (row["Student ID"] || row["student_id"]) {
        studentData.student_id = row["Student ID"] || row["student_id"];
      }

      // Parse enrollment data if present
      if (row["Semester ID"] || row["semester_id"]) {
        studentData.enrollment = {
          semester_id: parseInt(row["Semester ID"] || row["semester_id"]),
          scheme_id: parseInt(row["Scheme ID"] || row["scheme_id"]),
          status: row["Enrollment Status"] || row["status"] || "Enrolled",
        };
      }

      // Parse subjects data (comma-separated format)
      const subjectsStr = row["Subjects"] || row["subjects"];
      if (subjectsStr) {
        studentData.subjects = parseSubjectsString(subjectsStr);
      }

      return studentData;
    });

    const validStudents = students.filter((s) => s.first_name && s.last_name && s.email);
    console.log("Valid students after filtering:", validStudents.length);
    
    return validStudents;
  }

  // Helper function to parse date
  function parseDate(dateValue) {
    if (!dateValue) return null;

    // If it's already a valid date string
    if (typeof dateValue === "string") {
      return dateValue;
    }

    // If it's an Excel serial number
    if (typeof dateValue === "number") {
      const date = XLSX.SSF.parse_date_code(dateValue);
      return `${date.y}-${String(date.m).padStart(2, "0")}-${String(
        date.d
      ).padStart(2, "0")}`;
    }

    return null;
  }

  // Helper function to parse subjects string
  function parseSubjectsString(subjectsStr) {
    if (!subjectsStr || typeof subjectsStr !== "string") return [];

    // Format: "1:85.5:88.0:Enrolled,2:90.0:92.5:Enrolled"
    const subjectParts = subjectsStr.split(",");
    return subjectParts
      .map((part) => {
        const [subject_id, midterm_grade, final_grade, status] = part
          .trim()
          .split(":");
        return {
          subject_id: parseInt(subject_id),
          midterm_grade: midterm_grade ? parseFloat(midterm_grade) : null,
          final_grade: final_grade ? parseFloat(final_grade) : null,
          status: status || "Enrolled",
        };
      })
      .filter((s) => !isNaN(s.subject_id));
  }

  // Helper function to process complete student with all details
  async function processStudentWithDetails(studentData) {
    console.log("\n=== Processing Student ===");
    console.log("Student Data:", JSON.stringify(studentData, null, 2));

    // Required fields validation
    const required = [
      "first_name",
      "last_name",
      "email",
      "dob",
      "program_code",
      "department_code",
      "year_level",
      "admission_year",
      "total_balance",
      "semester_name",
      "scheme_name",
    ];
    for (let field of required) {
      if (studentData[field] === undefined || studentData[field] === null) {
        throw new Error(`Missing required field: ${field}`);
      }
    }

    // Auto-set password to DOB if not provided
    if (!studentData.password) {
      studentData.password = studentData.dob;
    }

    // Check if student_id is provided, if not generate one
    let studentId;
    if (studentData.student_id) {
      // Validate that the provided student_id follows the format AYY-XXXX
      const studentIdPattern = /^A\d{2}-\d{4}$/;
      if (!studentIdPattern.test(studentData.student_id)) {
        throw new Error(`Invalid student_id format: ${studentData.student_id}. Expected format: AYY-XXXX (e.g., A25-0001)`);
      }
      
      // Check if student_id already exists
      const { data: existingStudent, error: checkError } = await supabase
        .from("students")
        .select("student_id")
        .eq("student_id", studentData.student_id)
        .single();
      
      if (existingStudent) {
        throw new Error(`Student ID ${studentData.student_id} already exists`);
      }
      
      studentId = studentData.student_id;
      console.log("Using provided student_id:", studentId);
    } else {
      // Generate student ID if not provided
      studentId = await generateStudentId(studentData.admission_year);
      console.log("Generated student_id:", studentId);
    }

    // Step 1: Get program_id and department_id
    console.log("\nStep 1: Looking up program:", studentData.program_code);
    const { data: programData, error: programError } = await supabase
      .from("programs")
      .select("program_id, department_id")
      .eq("program_code", studentData.program_code)
      .single();

    console.log("Program query result:", { programData, programError });
    if (programError || !programData) {
      throw new Error(`Invalid program code: ${studentData.program_code}`);
    }

    // Step 2: Verify department matches
    console.log("\nStep 2: Verifying department:", studentData.department_code);
    const { data: deptData, error: deptError } = await supabase
      .from("departments")
      .select("department_id")
      .eq("department_code", studentData.department_code)
      .single();

    console.log("Department query result:", { deptData, deptError });
    if (deptError || !deptData) {
      throw new Error(
        `Invalid department code: ${studentData.department_code}`
      );
    }

    // Step 3: Get semester_id from semester_name
    console.log("\nStep 3: Looking up semester:", studentData.semester_name);
    const { data: semesterData, error: semesterError } = await supabase
      .from("semesters")
      .select("semester_id")
      .eq("semester_name", studentData.semester_name)
      .single();

    console.log("Semester query result:", { semesterData, semesterError });
    if (semesterError || !semesterData) {
      throw new Error(`Invalid semester name: ${studentData.semester_name}`);
    }

    // Step 4: Get scheme_id
    console.log("\nStep 4: Looking up tuition scheme");
    console.log("Query parameters:", {
      program_id: programData.program_id,
      year: studentData.year_level,
      scheme_name: studentData.scheme_name,
      semester_id: semesterData.semester_id,
    });

    const { data: schemeData, error: schemeError } = await supabaseAdmin
      .from("tuition_schemes")
      .select("*")
      .eq("program_id", programData.program_id)
      .eq("year", studentData.year_level)
      .ilike("scheme_name", `${studentData.scheme_name}%`)
      .eq("semester_id", semesterData.semester_id);

    console.log("Scheme query result:", {
      schemeData,
      schemeError,
      count: schemeData ? schemeData.length : 0,
    });

    // If no results, try without semester_id to see what's available
    if (!schemeData || schemeData.length === 0) {
      console.log(
        "\nNo scheme found. Checking what schemes exist for this program/year:"
      );
      const { data: availableSchemes } = await supabaseAdmin
        .from("tuition_schemes")
        .select("*")
        .eq("program_id", programData.program_id)
        .eq("year", studentData.year_level);

      console.log("Available schemes:", availableSchemes);
      
      const availableNames = availableSchemes?.map(s => `"${s.scheme_name}" (semester_id: ${s.semester_id})`).join(", ") || "none";
      throw new Error(
        `Invalid scheme name: "${studentData.scheme_name}" for program ${studentData.program_code}, year ${studentData.year_level}, semester ${studentData.semester_name}. Available schemes: ${availableNames}`
      );
    }

    const scheme = schemeData[0];
    console.log("Selected scheme:", scheme);

    // Step 5: Get all subjects for this program, year level, and semester
    const { data: subjectsData, error: subjectsError } = await supabase
      .from("course_subjects")
      .select(
        `
      subject_id,
      subject_code,
      subject_name,
      prerequisite_id,
      units
    `
      )
      .eq("program_id", programData.program_id)
      .eq("year_level", studentData.year_level)
      .eq("semester_id", semesterData.semester_id);

    if (subjectsError) {
      throw new Error(`Failed to fetch subjects: ${subjectsError.message}`);
    }

    if (!subjectsData || subjectsData.length === 0) {
      throw new Error(
        `No subjects found for program ${studentData.program_code}, year ${studentData.year_level}, semester ${studentData.semester_name}`
      );
    }

    // Step 7: Create username from name
    const username = `${studentData.first_name}.${studentData.last_name}`
      .toLowerCase()
      .replace(/\s+/g, "");
    const hashedPassword = await bcrypt.hash(studentData.password, 10);

    // Step 8: Get student role_id
    const { data: roleData, error: roleError } = await supabase
      .from("roles")
      .select("role_id")
      .eq("role_name", "Student")
      .single();

    if (roleError || !roleData) {
      throw new Error("Student role not found in database");
    }

    // Step 9: Create Supabase Auth user
    const { data: authData, error: authError } =
      await supabaseAdmin.auth.admin.createUser({
        email: studentData.email,
        password: studentData.password,
        email_confirm: true,
        user_metadata: {
          username: username,
          role_id: roleData.role_id,
          student_id: studentId,
          first_name: studentData.first_name,
          last_name: studentData.last_name,
        },
      });

    if (authError) {
      throw new Error(`Auth creation failed: ${authError.message}`);
    }

    try {
      // Step 10: Insert into users table
      const { data: userData, error: userError } = await supabase
        .from("users")
        .insert([
          {
            id: authData.user.id,
            username: username,
            password_hash: hashedPassword,
            role_id: roleData.role_id,
            email: studentData.email,
          },
        ])
        .select()
        .single();

      if (userError)
        throw new Error(`User insert failed: ${userError.message}`);

      // Step 11: Insert into students table
      const { data: studentRecord, error: studentError } = await supabase
        .from("students")
        .insert([
          {
            student_id: studentId,
            user_id: userData.user_id,
            first_name: studentData.first_name,
            last_name: studentData.last_name,
            dob: studentData.dob,
            email: studentData.email,
            program_id: programData.program_id,
            department_id: deptData.department_id,
            year_level: studentData.year_level,
            admission_year: studentData.admission_year,
          },
        ])
        .select()
        .single();

      if (studentError)
        throw new Error(`Student insert failed: ${studentError.message}`);

      // Step 12: Create account for student
      const { data: accountData, error: accountError } = await supabase
        .from("accounts")
        .insert([
          {
            student_id: studentId,
            total_balance: studentData.total_balance || 0,
          },
        ])
        .select()
        .single();

      if (accountError)
        throw new Error(`Account creation failed: ${accountError.message}`);

      // Step 13: Create enrollment
      const { data: enrollment, error: enrollmentError } = await supabase
        .from("enrollments")
        .insert([
          {
            student_id: studentId,
            program_id: programData.program_id,
            scheme_id: scheme.scheme_id,
            semester_id: semesterData.semester_id,
            status: "Enrolled",
          },
        ])
        .select()
        .single();

      if (enrollmentError) {
        throw new Error(
          `Enrollment creation failed: ${enrollmentError.message}`
        );
      }

      // Step 14: Enroll in all subjects
      const gradesMap = {};
      if (studentData.grades && Array.isArray(studentData.grades)) {
        studentData.grades.forEach((grade) => {
          gradesMap[grade.subject_code || grade.subject_id] = {
            midterm_grade: grade.midterm_grade || null,
            final_grade: grade.final_grade || null,
          };
        });
      }

      const enrollmentSubjects = subjectsData.map((subject) => {
        const grades =
          gradesMap[subject.subject_code] ||
          gradesMap[subject.subject_id] ||
          {};
        return {
          enrollment_id: enrollment.enrollment_id,
          subject_id: subject.subject_id,
          status: "Enrolled",
          midterm_grade: grades.midterm_grade || null,
          final_grade: grades.final_grade || null,
        };
      });

      const { data: insertedSubjects, error: subjectsInsertError } =
        await supabase.from("enrollment_subjects").insert(enrollmentSubjects)
          .select(`
        enrollment_subject_id,
        subject_id,
        status,
        midterm_grade,
        final_grade,
        course_subjects (
          subject_code,
          subject_name,
          units
        )
      `);

      if (subjectsInsertError) {
        throw new Error(
          `Subjects enrollment failed: ${subjectsInsertError.message}`
        );
      }

      // Return complete student data
      return {
        student_id: studentId,
        user_id: userData.user_id,
        auth_id: authData.user.id,
        username: username,
        email: studentData.email,
        first_name: studentData.first_name,
        last_name: studentData.last_name,
        program_code: studentData.program_code,
        department_code: studentData.department_code,
        year_level: studentData.year_level,
        semester: studentData.semester_name,
        scheme: studentData.scheme_name,
        account_id: accountData.account_id,
        total_balance: accountData.total_balance,
        enrollment: {
          enrollment_id: enrollment.enrollment_id,
          status: enrollment.status,
          subjects: insertedSubjects,
          total_subjects: insertedSubjects.length,
        },
        message:
          "Student created successfully with automatic subject enrollment",
      };
    } catch (error) {
      // Rollback: Delete auth user if any step fails
      await supabaseAdmin.auth.admin.deleteUser(authData.user.id);
      throw error;
    }
  }

  // Helper function to generate student ID
  async function generateStudentId(year) {
    // Get last 2 digits of year (e.g., 2025 -> 25)
    const yearSuffix = String(year).slice(-2);
    
    const { data, error } = await supabase
      .from("student_id_generator")
      .select("last_number")
      .eq("year", year)
      .single();

    let nextNumber;
    if (error || !data) {
      // First student for this year
      nextNumber = 1;
      await supabase
        .from("student_id_generator")
        .insert([{ year: year, last_number: 1 }]);
    } else {
      // Increment the counter
      nextNumber = data.last_number + 1;
      await supabase
        .from("student_id_generator")
        .update({ last_number: nextNumber })
        .eq("year", year);
    }

    // Format: AYY-XXXX (e.g., A25-0001)
    return `A${yearSuffix}-${String(nextNumber).padStart(4, "0")}`;
  }

  // Helper functions for bulk creation
  async function fetchRoles() {
    const { data, error } = await supabase
      .from("roles")
      .select("role_id, role_name");

    if (error) throw new Error("Failed to fetch roles");
    return data;
  }

  function createRoleMap(roles) {
    const map = {};
    roles.forEach((role) => {
      map[role.role_name.toLowerCase()] = role.role_id;
    });
    return map;
  }

  async function processUser(userData, roleMap) {
    const username =
      userData.username ||
      `${userData.first_name}.${userData.last_name}`.toLowerCase();
    const email = userData.email;
    const role_id =
      roleMap[userData.role_name?.toLowerCase()] || roleMap["user"];
    const password = userData.password || "DefaultPass123!";

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create auth user
    const { data: authData, error: authError } =
      await supabaseAdmin.auth.admin.createUser({
        email: email,
        password: password,
        email_confirm: true,
        user_metadata: {
          username: username,
          role_id: role_id,
        },
      });

    if (authError) throw new Error(authError.message);

    // Insert into users table
    const { data, error } = await supabase
      .from("users")
      .insert([
        {
          username: username,
          password_hash: hashedPassword,
          role_id: role_id,
          email: email,
        },
      ])
      .select()
      .single();

    if (error) {
      // Rollback auth user
      await supabaseAdmin.auth.admin.deleteUser(authData.user.id);
      throw new Error(error.message);
    }

    return data;
  }

  return router;
}

module.exports = createUsersRouter;