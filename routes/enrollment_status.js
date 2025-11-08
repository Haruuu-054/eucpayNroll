const express = require("express");

function enrollmentstatus(supabase, logger) {
  const router = express.Router();

router.get("/", async (req, res) => {
  try {
    // Step 1: Fetch pending enrollments
    const { data: enrollments, error: enrollmentsError } = await supabase
      .from("enrollments")
      .select("student_id, status, created_at, scheme_id, program_id")
      .eq("status", "Pending");
     
    if (enrollmentsError) {
      logger.error(
        "Error fetching pending enrollments: " + enrollmentsError.message
      );
      return res
        .status(500)
        .json({ error: "Failed to fetch pending enrollments" });
    }
     
    if (!enrollments || enrollments.length === 0) {
      return res.status(200).json({
        success: true,
        data: [],
      });
    }
     
    // Extract unique IDs
    const schemeIds = [...new Set(enrollments.map((e) => e.scheme_id))];
    const programIds = [...new Set(enrollments.map((e) => e.program_id))];
    const studentIds = [...new Set(enrollments.map((e) => e.student_id))];
     
    // Step 2: Fetch tuition schemes
    const { data: tuitionSchemes, error: schemesError } = await supabase
      .from("tuition_schemes")
      .select("scheme_id, scheme_name, amount")
      .in("scheme_id", schemeIds);
     
    if (schemesError) {
      logger.error("Error fetching tuition schemes: " + schemesError.message);
      return res
        .status(500)
        .json({ error: "Failed to fetch tuition schemes" });
    }
     
    // Step 3: Fetch programs
    const { data: programs, error: programsError } = await supabase
      .from("programs")
      .select("program_id, program_name")
      .in("program_id", programIds);
     
    if (programsError) {
      logger.error("Error fetching programs: " + programsError.message);
      return res.status(500).json({ error: "Failed to fetch programs" });
    }
    
    // Step 4: Fetch students (NEW!)
    const { data: students, error: studentsError } = await supabase
      .from("students")
      .select("student_id, first_name, last_name")
      .in("student_id", studentIds);
     
    if (studentsError) {
      logger.error("Error fetching students: " + studentsError.message);
      return res.status(500).json({ error: "Failed to fetch students" });
    }
    
    // Step 5: Map data
    const schemeMap = tuitionSchemes.reduce((map, s) => {
      map[s.scheme_id] = s;
      return map;
    }, {});
     
    const programMap = programs.reduce((map, p) => {
      map[p.program_id] = p;
      return map;
    }, {});
    
    const studentMap = students.reduce((map, s) => {
      map[s.student_id] = s;
      return map;
    }, {});
     
    const formattedData = enrollments.map((item) => {
      const scheme = schemeMap[item.scheme_id];
      const program = programMap[item.program_id];
      const student = studentMap[item.student_id];
      
      return {
        student_id: item.student_id,
        first_name: student ? student.first_name : "Unknown",
        last_name: student ? student.last_name : "Unknown",
        full_name: student ? `${student.first_name} ${student.last_name}` : "Unknown",
        tuition_scheme_name: scheme ? scheme.scheme_name : "Unknown",
        tuition_amount: scheme ? scheme.amount : 0,
        enrollment_status: item.status,
        date_of_enrollment: item.created_at,
        enrolled_program: program ? program.program_name : "Unknown",
      };
    });
     
    res.status(200).json({
      success: true,
      data: formattedData,
    });
  } catch (err) {
    logger.error("Error in enrollment status endpoint: " + err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

  return router;
}

function enrolledcounts(supabase, logger) {
  const router = express.Router();

 router.get("/", async (req, res) => {
  try {
    const { count, error } = await supabase
      .from("enrollments")
      .select("*", { count: "exact", head: true }) // 'head: true' skips fetching rows, just returns count
      .eq("status", "Enrolled");

    if (error) {
      logger.error("Error in enrolled students endpoint: " + error.message);
      return res.status(500).json({ error: "Internal server error" });
    }

    // Success case: Send the count as JSON
    res.json({ count }); // Use 'count' directly (it's a number, e.g., 5 or 0)
  } catch (err) {
    logger.error("Error in enrolled students endpoint: " + err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

  return router;
}

function pendingcounts(supabase, logger) {
  const router = express.Router();

 router.get("/", async (req, res) => {
  try {
    const { count, error } = await supabase
      .from("enrollments")
      .select("*", { count: "exact", head: true })
      .eq("status", "Pending");

    if (error) {
      logger.error("Error in enrolled students endpoint: " + error.message);
      return res.status(500).json({ error: "Internal server error" });
    }

    res.json({ count });
  } catch (err) {
    logger.error("Error in enrolled students endpoint: " + err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

  return router;
}


module.exports = {
  enrollmentstatus,
  enrolledcounts,
  pendingcounts
};
