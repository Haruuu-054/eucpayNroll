// routes/enrollment.js
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');

function createEnrollmentProcessRouter(supabase, logger) {

router.post('/create', async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const { student_id, program_id, scheme_id, target_semester_id, user_id, selected_subject_ids } = req.body;
    
    // 0. Get student's current year level and validate they're not already enrolled for target semester
    const studentResult = await client.query(`
      SELECT year_level, program_id
      FROM students
      WHERE student_id = $1
    `, [student_id]);
    
    if (studentResult.rows.length === 0) {
      throw new Error('Student not found');
    }
    
    const student = studentResult.rows[0];
    const year_level = student.year_level;
    
    // Check if student already has a pending or completed enrollment for this semester
    const existingEnrollment = await client.query(`
      SELECT enrollment_id, status
      FROM enrollments
      WHERE student_id = $1 
        AND semester_id = $2
        AND status IN ('Pending', 'Enrolled')
    `, [student_id, target_semester_id]);
    
    if (existingEnrollment.rows.length > 0) {
      const status = existingEnrollment.rows[0].status;
      throw new Error(
        status === 'Pending' 
          ? 'You already have a pending enrollment for this semester. Please complete payment first.'
          : 'You are already enrolled for this semester.'
      );
    }
    
    // Verify the target semester is within the active enrollment period
    const enrollmentPeriodCheck = await client.query(`
      SELECT 
        ep.period_id,
        ep.enrollment_start_date,
        ep.enrollment_end_date,
        ep.is_active,
        s.semester_name,
        s.school_year
      FROM enrollment_periods ep
      JOIN semesters s ON ep.semester_id = s.semester_id
      WHERE ep.semester_id = $1
        AND ep.is_active = true
        AND NOW() BETWEEN ep.enrollment_start_date AND ep.enrollment_end_date
    `, [target_semester_id]);
    
    if (enrollmentPeriodCheck.rows.length === 0) {
      throw new Error('Enrollment period for this semester is not yet open or has ended.');
    }
    
    const enrollmentPeriod = enrollmentPeriodCheck.rows[0];
    
    // 1. Create enrollment record (status: Pending) for the TARGET semester
    const enrollmentResult = await client.query(`
      INSERT INTO enrollments (student_id, program_id, scheme_id, semester_id, status)
      VALUES ($1, $2, $3, $4, 'Pending')
      RETURNING enrollment_id
    `, [student_id, program_id, scheme_id, target_semester_id]);
    
    const enrollment_id = enrollmentResult.rows[0].enrollment_id;
    
    // 2. Get subjects for the student's program, year level, and TARGET semester
    let subjectsToEnroll;
    
    if (selected_subject_ids && selected_subject_ids.length > 0) {
      // If student manually selected subjects (e.g., for irregular students or electives)
      subjectsToEnroll = await client.query(`
        SELECT 
          cs.subject_id,
          cs.subject_code,
          cs.subject_name,
          cs.units,
          cs.is_elective,
          cs.prerequisite_id
        FROM course_subjects cs
        WHERE cs.subject_id = ANY($1)
          AND cs.program_id = $2
          AND cs.semester_id = $3
      `, [selected_subject_ids, program_id, target_semester_id]);
    } else {
      // Automatically get subjects based on program, year level, and TARGET semester
      subjectsToEnroll = await client.query(`
        SELECT 
          cs.subject_id,
          cs.subject_code,
          cs.subject_name,
          cs.units,
          cs.is_elective,
          cs.prerequisite_id
        FROM course_subjects cs
        WHERE cs.program_id = $1
          AND cs.year_level = $2
          AND cs.semester_id = $3
        ORDER BY cs.subject_code
      `, [program_id, year_level, target_semester_id]);
    }
    
    if (subjectsToEnroll.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: `No subjects found for ${enrollmentPeriod.semester_name} (${enrollmentPeriod.school_year})`
      });
    }
    
    // 3. Check prerequisites for each subject
    const enrolledSubjects = [];
    const failedPrerequisites = [];
    
    for (const subject of subjectsToEnroll.rows) {
      if (subject.prerequisite_id) {
        // Check if student has passed the prerequisite in ANY previous semester
        const prereqCheck = await client.query(`
          SELECT es.final_grade
          FROM enrollment_subjects es
          JOIN enrollments e ON es.enrollment_id = e.enrollment_id
          WHERE e.student_id = $1
            AND es.subject_id = $2
            AND es.final_grade >= 3.0
            AND e.status = 'Enrolled'
          ORDER BY e.created_at DESC
          LIMIT 1
        `, [student_id, subject.prerequisite_id]);
        
        if (prereqCheck.rows.length === 0) {
          // Prerequisite not met
          failedPrerequisites.push({
            subject_code: subject.subject_code,
            subject_name: subject.subject_name,
            prerequisite_id: subject.prerequisite_id
          });
          continue; // Skip this subject
        }
      }
      
      // Check if student already passed this subject before
      const alreadyPassedCheck = await client.query(`
        SELECT es.final_grade
        FROM enrollment_subjects es
        JOIN enrollments e ON es.enrollment_id = e.enrollment_id
        WHERE e.student_id = $1
          AND es.subject_id = $2
          AND es.final_grade >= 3.0
          AND e.status = 'Enrolled'
        LIMIT 1
      `, [student_id, subject.subject_id]);
      
      if (alreadyPassedCheck.rows.length > 0 && !subject.is_elective) {
        // Skip subjects already passed (unless it's an elective that can be retaken)
        continue;
      }
      
      // Enroll student in subject
      await client.query(`
        INSERT INTO enrollment_subjects (enrollment_id, subject_id, status)
        VALUES ($1, $2, 'Enrolled')
      `, [enrollment_id, subject.subject_id]);
      
      enrolledSubjects.push(subject);
    }
    
    if (enrolledSubjects.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: 'No eligible subjects to enroll. All subjects either have unmet prerequisites or have been completed.',
        failed_prerequisites: failedPrerequisites
      });
    }
    
    // Calculate total units
    const totalUnits = enrolledSubjects.reduce((sum, subj) => sum + (subj.units || 0), 0);
    
    // 4. Get tuition scheme details for the target semester
    const schemeResult = await client.query(`
      SELECT amount, downpayment, discount, scheme_type
      FROM tuition_schemes
      WHERE scheme_id = $1
    `, [scheme_id]);
    
    if (schemeResult.rows.length === 0) {
      throw new Error('Tuition scheme not found');
    }
    
    const scheme = schemeResult.rows[0];
    const totalAmount = scheme.amount - scheme.discount;
    
    // 5. Create enrollment fees based on scheme and subjects
    const fees = [
      { 
        type: 'Tuition', 
        description: `Tuition Fee for ${enrollmentPeriod.semester_name} (${totalUnits} units)`, 
        amount: totalAmount 
      },
      // Add other fees based on subjects or program requirements
      { 
        type: 'Laboratory', 
        description: 'Laboratory Fees', 
        amount: calculateLabFees(enrolledSubjects) // Helper function
      },
      { 
        type: 'Miscellaneous', 
        description: 'Miscellaneous Fees', 
        amount: 500 
      }
    ];
    
    let totalFees = 0;
    for (const fee of fees) {
      if (fee.amount > 0) {
        await client.query(`
          INSERT INTO enrollment_fees (enrollment_id, fee_type, description, amount, is_paid)
          VALUES ($1, $2, $3, $4, false)
        `, [enrollment_id, fee.type, fee.description, fee.amount]);
        totalFees += fee.amount;
      }
    }
    
    await client.query('COMMIT');
    
    res.json({
      success: true,
      enrollment_id,
      semester_info: {
        semester_id: target_semester_id,
        semester_name: enrollmentPeriod.semester_name,
        school_year: enrollmentPeriod.school_year
      },
      enrolled_subjects: enrolledSubjects.map(s => ({
        subject_id: s.subject_id,
        subject_code: s.subject_code,
        subject_name: s.subject_name,
        units: s.units,
        is_elective: s.is_elective
      })),
      total_units: totalUnits,
      failed_prerequisites: failedPrerequisites,
      fees: fees,
      total_amount: totalFees,
      message: `Enrollment created for ${enrollmentPeriod.semester_name} (${enrollmentPeriod.school_year}). Please proceed to payment to confirm enrollment.`
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Enrollment creation error:', error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    client.release();
  }
});

router.get('/:enrollment_id/subjects', async (req, res) => {
  try {
    const { enrollment_id } = req.params;
    
    const result = await pool.query(`
      SELECT 
        es.enrollment_subject_id,
        es.subject_id,
        cs.subject_code,
        cs.subject_name,
        cs.units,
        cs.is_elective,
        es.status,
        es.midterm_grade,
        es.final_grade,
        t.first_name || ' ' || t.last_name as teacher_name,
        sch.day_of_week,
        sch.start_time,
        sch.end_time,
        sch.room
      FROM enrollment_subjects es
      JOIN course_subjects cs ON es.subject_id = cs.subject_id
      LEFT JOIN course_schedules sch ON cs.subject_id = sch.subject_id
      LEFT JOIN teachers t ON sch.teacher_id = t.teacher_id
      WHERE es.enrollment_id = $1
      ORDER BY cs.subject_code
    `, [enrollment_id]);
    
    const totalUnits = result.rows.reduce((sum, subj) => sum + (subj.units || 0), 0);
    
    res.json({
      success: true,
      subjects: result.rows,
      total_units: totalUnits
    });
    
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/next', async (req, res) => {
  try {
    const { student_id } = req.query;
    
    if (!student_id) {
      return res.status(400).json({
        success: false,
        message: 'student_id is required'
      });
    }
    
    // Get the active enrollment period
    const periodResult = await client.query(`
      SELECT 
        ep.period_id,
        ep.semester_id,
        ep.enrollment_start_date,
        ep.enrollment_end_date,
        ep.is_active,
        s.semester_name,
        s.school_year,
        s.start_date as semester_start,
        s.end_date as semester_end
      FROM enrollment_periods ep
      JOIN semesters s ON ep.semester_id = s.semester_id
      WHERE ep.is_active = true
        AND NOW() BETWEEN ep.enrollment_start_date AND ep.enrollment_end_date
      ORDER BY ep.enrollment_start_date ASC
      LIMIT 1
    `);
    
    if (periodResult.rows.length === 0) {
      return res.json({
        success: true,
        can_enroll: false,
        message: 'No active enrollment period at the moment.',
        next_period: null
      });
    }
    
    const period = periodResult.rows[0];
    
    // Check if student already enrolled for this semester
    const existingEnrollment = await client.query(`
      SELECT enrollment_id, status
      FROM enrollments
      WHERE student_id = $1 
        AND semester_id = $2
        AND status IN ('Pending', 'Enrolled')
    `, [student_id, period.semester_id]);
    
    if (existingEnrollment.rows.length > 0) {
      const enrollment = existingEnrollment.rows[0];
      return res.json({
        success: true,
        can_enroll: false,
        message: enrollment.status === 'Pending' 
          ? 'You have a pending enrollment. Please complete payment first.'
          : 'You are already enrolled for this semester.',
        current_enrollment: {
          enrollment_id: enrollment.enrollment_id,
          status: enrollment.status
        },
        next_period: period
      });
    }
    
    // Get student info
    const studentResult = await client.query(`
      SELECT 
        s.student_id,
        s.first_name,
        s.last_name,
        s.year_level,
        s.program_id,
        p.program_name,
        a.total_balance
      FROM students s
      JOIN programs p ON s.program_id = p.program_id
      LEFT JOIN accounts a ON s.student_id = a.student_id
      WHERE s.student_id = $1
    `, [student_id]);
    
    if (studentResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Student not found'
      });
    }
    
    const student = studentResult.rows[0];
    
    // Check if student has outstanding balance that might block enrollment
    const hasOutstandingBalance = student.total_balance && parseFloat(student.total_balance) > 0;
    
    res.json({
      success: true,
      can_enroll: true,
      enrollment_period: {
        period_id: period.period_id,
        semester_id: period.semester_id,
        semester_name: period.semester_name,
        school_year: period.school_year,
        enrollment_start_date: period.enrollment_start_date,
        enrollment_end_date: period.enrollment_end_date,
        semester_start: period.semester_start,
        semester_end: period.semester_end
      },
      student_info: {
        student_id: student.student_id,
        name: `${student.first_name} ${student.last_name}`,
        year_level: student.year_level,
        program: student.program_name,
        has_outstanding_balance: hasOutstandingBalance,
        outstanding_balance: student.total_balance || 0
      },
      message: `Enrollment is open for ${period.semester_name} (${period.school_year})`
    });
    
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/available', async (req, res) => {
  try {
    const { program_id, year_level, semester_id, student_id } = req.query;
    
    if (!program_id || !year_level || !semester_id) {
      return res.status(400).json({
        success: false,
        message: 'program_id, year_level, and semester_id are required'
      });
    }
    
    // Get all subjects for the program, year level, and semester
    const subjectsResult = await pool.query(`
      SELECT 
        cs.subject_id,
        cs.subject_code,
        cs.subject_name,
        cs.units,
        cs.is_elective,
        cs.prerequisite_id,
        prereq.subject_code as prerequisite_code,
        prereq.subject_name as prerequisite_name,
        cs.subject_type
      FROM course_subjects cs
      LEFT JOIN course_subjects prereq ON cs.prerequisite_id = prereq.subject_id
      WHERE cs.program_id = $1
        AND cs.year_level = $2
        AND cs.semester_id = $3
      ORDER BY cs.is_elective, cs.subject_code
    `, [program_id, year_level, semester_id]);
    
    if (!student_id) {
      // Just return available subjects without checking prerequisites
      return res.json({
        success: true,
        subjects: subjectsResult.rows,
        total_subjects: subjectsResult.rows.length
      });
    }
    
    // Check which subjects the student has already taken
    const takenSubjectsResult = await pool.query(`
      SELECT DISTINCT es.subject_id, es.final_grade
      FROM enrollment_subjects es
      JOIN enrollments e ON es.enrollment_id = e.enrollment_id
      WHERE e.student_id = $1
    `, [student_id]);
    
    const takenSubjectsMap = {};
    takenSubjectsResult.rows.forEach(row => {
      takenSubjectsMap[row.subject_id] = row.final_grade;
    });
    
    // Mark subjects as eligible, already taken, or prerequisite not met
    const enrichedSubjects = subjectsResult.rows.map(subject => {
      const alreadyTaken = subject.subject_id in takenSubjectsMap;
      const passedGrade = alreadyTaken && takenSubjectsMap[subject.subject_id] >= 3.0;
      
      let eligibility = {
        can_enroll: true,
        reason: null
      };
      
      if (alreadyTaken) {
        if (passedGrade) {
          eligibility = {
            can_enroll: false,
            reason: 'Already passed'
          };
        } else {
          eligibility = {
            can_enroll: true,
            reason: 'Retake'
          };
        }
      } else if (subject.prerequisite_id) {
        const prereqPassed = subject.prerequisite_id in takenSubjectsMap && 
                           takenSubjectsMap[subject.prerequisite_id] >= 3.0;
        
        if (!prereqPassed) {
          eligibility = {
            can_enroll: false,
            reason: `Prerequisite required: ${subject.prerequisite_code} - ${subject.prerequisite_name}`
          };
        }
      }
      
      return {
        ...subject,
        eligibility
      };
    });
    
    res.json({
      success: true,
      subjects: enrichedSubjects,
      total_subjects: enrichedSubjects.length,
      eligible_subjects: enrichedSubjects.filter(s => s.eligibility.can_enroll).length
    });
    
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});



return router;

}

// Helper function to calculate lab fees based on subjects
function calculateLabFees(subjects) {
  // Define subjects that require lab fees (you can store this in database)
  const labSubjects = ['CS', 'IT', 'CHEM', 'PHYS', 'BIO']; // Subject code prefixes
  let labFee = 0;
  
  subjects.forEach(subject => {
    const hasLab = labSubjects.some(prefix => 
      subject.subject_code.startsWith(prefix)
    );
    if (hasLab) {
      labFee += 300; // 300 per lab subject
    }
  });
  
  return labFee;
}

module.exports = createEnrollmentProcessRouter;