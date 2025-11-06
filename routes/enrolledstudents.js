const express = require('express');

function getEnrolledStudentsRouter(supabase, logger) {
  const router = express.Router();

  router.get("/", async (req, res) => {
  try {
    const { semesterId } = req.query;
    console.log('📌 Semester ID:', semesterId);

    if (!semesterId) {
      return res.status(400).json({
        success: false,
        message: 'semesterId is required'
      });
    }

    // 1️⃣ Fetch enrollments
    const { data: enrollments, error: enrollError } = await supabase
      .from('enrollments')
      .select(`
        enrollment_id,
        student_id,
        status,
        semester_id,
        semesters (
          semester_name,
          school_year
        )
      `)
      .eq('status', 'Enrolled')
      .eq('semester_id', semesterId);

    console.log('📌 Enrollments found:', enrollments?.length || 0);
    console.log('📌 Enrollment error:', enrollError);

    if (enrollError) throw enrollError;

    if (!enrollments || enrollments.length === 0) {
      return res.status(200).json({
        success: true,
        data: {},
        message: 'No enrollments found'
      });
    }

    const studentIds = enrollments.map(e => e.student_id);
    console.log('📌 Student IDs:', studentIds);

    // 3️⃣ Fetch students
    const { data: students, error: studentsError } = await supabase
      .from('students')
      .select(`
        student_id,
        first_name,
        last_name,
        email,
        year_level,
        departments (
          department_id,
          department_name
        ),
        programs (
          program_id,
          program_name,
          program_code
        )
      `)
      .in('student_id', studentIds);

    console.log('📌 Students found:', students?.length || 0);
    console.log('📌 Students error:', studentsError);
    console.log('📌 Sample student:', students?.[0]);

    if (studentsError) throw studentsError;

    // Rest of your code...

      // 4️⃣ Create a map for quick lookup
      const studentMap = {};
      students.forEach(student => {
        studentMap[student.student_id] = student;
      });

      // 5️⃣ Merge enrollment + student data
      const combinedData = enrollments.map(enrollment => {
        const student = studentMap[enrollment.student_id];
        if (!student) return null;

        return {
          student_id: student.student_id,
          first_name: student.first_name,
          last_name: student.last_name,
          email: student.email,
          year_level: student.year_level,
          department_name: student.departments.department_name,
          program_name: student.programs.program_name,
          program_code: student.programs.program_code, // ✅ Added here
          enrollment_status: enrollment.status,
          semester_name: enrollment.semesters.semester_name,
          school_year: enrollment.semesters.school_year,
          semester_id: semesterId
        };
      }).filter(item => item !== null);

      // 6️⃣ Sort results for stable grouping
      const sortedData = combinedData.sort((a, b) => {
        const deptCompare = a.department_name.localeCompare(b.department_name);
        if (deptCompare !== 0) return deptCompare;

        const progCompare = a.program_name.localeCompare(b.program_name);
        if (progCompare !== 0) return progCompare;

        const yearCompare = a.year_level - b.year_level;
        if (yearCompare !== 0) return yearCompare;

        return a.last_name.localeCompare(b.last_name);
      });

      // 7️⃣ Group by Department → Program Code → Year Level
      const groupedData = {};

      sortedData.forEach(student => {
        const dept = student.department_name;
        const program = student.program_code || student.program_name; // ✅ Use code first
        const year = student.year_level;

        if (!groupedData[dept]) groupedData[dept] = {};
        if (!groupedData[dept][program]) groupedData[dept][program] = {};
        if (!groupedData[dept][program][year]) groupedData[dept][program][year] = [];

        groupedData[dept][program][year].push({
          student_id: student.student_id,
          first_name: student.first_name,
          last_name: student.last_name,
          email: student.email,
          year_level: student.year_level,
          enrollment_status: student.enrollment_status,
          semester_name: student.semester_name,
          school_year: student.school_year,
          semester_id: semesterId
        });
      });

      // ✅ Return grouped result
      return res.status(200).json({
        success: true,
        data: groupedData
      });

    } catch (error) {
      logger.error('Error fetching enrolled students:', error);
      return res.status(500).json({
        success: false,
        message: error.message
      });
    }
  });

  return router;
}

module.exports = getEnrolledStudentsRouter;
