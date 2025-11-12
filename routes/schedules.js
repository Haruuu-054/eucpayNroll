// routes/schedules.js
const express = require("express");

function createSchedulesRouter(supabase) {
  const router = express.Router();

  // ============================================
  // STUDENT SCHEDULE ENDPOINTS (Existing)
  // ============================================

  /**
   * GET /course/schedules/student/:studentId
   * Get schedule for a specific enrolled student
   */
  /**
   * GET /course/schedules/debug/student/:studentId
   * Debug endpoint to diagnose why schedules aren't showing
   */
  router.get("/debug/student/:studentId", async (req, res) => {
    const { studentId } = req.params;

    try {
      console.log(`🔍 DEBUG: Checking student ${studentId}`);

      // Step 1: Get student info
      const { data: student, error: studentError } = await supabase
        .from("students")
        .select("student_id, first_name, last_name, year_level")
        .eq("student_id", studentId)
        .single();

      if (studentError) {
        return res.json({
          step: 1,
          status: "❌ FAILED",
          error: "Student not found",
          details: studentError.message
        });
      }

      console.log(`✅ Step 1: Found student - ${student.first_name} ${student.last_name}, Year ${student.year_level}`);

      // Step 2: Get enrollments
      const { data: enrollments, error: enrollmentError } = await supabase
        .from("enrollments")
        .select(`
        enrollment_id,
        student_id,
        program_id,
        semester_id,
        status,
        enrollment_subjects (
          subject_id,
          status
        )
      `)
        .eq("student_id", studentId);

      if (enrollmentError) {
        return res.json({
          step: 2,
          status: "❌ FAILED",
          error: "Error fetching enrollments",
          details: enrollmentError.message,
          studentInfo: student
        });
      }

      if (!enrollments || enrollments.length === 0) {
        return res.json({
          step: 2,
          status: "❌ FAILED",
          error: "No enrollments found for this student",
          studentInfo: student,
          enrollments: []
        });
      }

      console.log(`✅ Step 2: Found ${enrollments.length} enrollment(s)`);

      // Step 3: Check active enrollment
      const activeEnrollment = enrollments.find(e =>
        e.status === "Enrolled" || e.status === "Active"
      );

      if (!activeEnrollment) {
        return res.json({
          step: 3,
          status: "❌ FAILED",
          error: "No active enrollment found",
          studentInfo: student,
          allEnrollments: enrollments.map(e => ({
            enrollment_id: e.enrollment_id,
            status: e.status,
            program_id: e.program_id,
            semester_id: e.semester_id
          }))
        });
      }

      console.log(`✅ Step 3: Found active enrollment ${activeEnrollment.enrollment_id}`);

      // Step 4: Check enrolled subjects
      const enrolledSubjects = activeEnrollment.enrollment_subjects.filter(es =>
        es.status === "Enrolled" || es.status === "Active"
      );

      const subjectIds = enrolledSubjects.map(es => es.subject_id);

      if (subjectIds.length === 0) {
        return res.json({
          step: 4,
          status: "❌ FAILED",
          error: "No enrolled subjects found",
          studentInfo: student,
          activeEnrollment: {
            enrollment_id: activeEnrollment.enrollment_id,
            program_id: activeEnrollment.program_id,
            semester_id: activeEnrollment.semester_id,
            status: activeEnrollment.status
          },
          allSubjects: activeEnrollment.enrollment_subjects
        });
      }

      console.log(`✅ Step 4: Found ${subjectIds.length} enrolled subjects:`, subjectIds);

      // Step 5: Check if schedules exist for these subjects
      const { data: schedules, error: scheduleError } = await supabase
        .from("course_schedules")
        .select(`
        schedule_id,
        subject_id,
        program_id,
        year_level,
        batch,
        start_time,
        end_time,
        room,
        semester_id,
        course_subjects (
          subject_id,
          subject_code,
          subject_name
        ),
        schedule_day_mapping (
          day_of_week
        )
      `)
        .eq("program_id", activeEnrollment.program_id)
        .eq("year_level", student.year_level)
        .in("subject_id", subjectIds);

      if (scheduleError) {
        return res.json({
          step: 5,
          status: "❌ FAILED",
          error: "Error fetching schedules",
          details: scheduleError.message,
          studentInfo: student,
          searchCriteria: {
            program_id: activeEnrollment.program_id,
            year_level: student.year_level,
            subject_ids: subjectIds
          }
        });
      }

      console.log(`✅ Step 5: Found ${schedules?.length || 0} schedules`);

      // Step 6: Check ALL schedules for this program/year (not filtered by subjects)
      const { data: allSchedules } = await supabase
        .from("course_schedules")
        .select("schedule_id, subject_id, program_id, year_level, semester_id")
        .eq("program_id", activeEnrollment.program_id)
        .eq("year_level", student.year_level);

      console.log(`✅ Step 6: Found ${allSchedules?.length || 0} total schedules for program/year`);

      // Step 7: Get subject details
      const { data: subjectDetails } = await supabase
        .from("course_subjects")
        .select("subject_id, subject_code, subject_name")
        .in("subject_id", subjectIds);

      // Final result
      return res.json({
        status: schedules && schedules.length > 0 ? "✅ SUCCESS" : "⚠️ NO SCHEDULES",
        summary: {
          studentId: student.student_id,
          studentName: `${student.first_name} ${student.last_name}`,
          yearLevel: student.year_level,
          programId: activeEnrollment.program_id,
          semesterId: activeEnrollment.semester_id,
          enrolledSubjects: subjectIds.length,
          schedulesFound: schedules?.length || 0,
          totalSchedulesForProgramYear: allSchedules?.length || 0
        },
        details: {
          enrolledSubjects: subjectDetails || [],
          schedulesForEnrolledSubjects: schedules || [],
          allSchedulesForProgramYear: allSchedules || []
        },
        diagnosis: getDiagnosis(schedules, allSchedules, subjectIds, subjectDetails)
      });

    } catch (error) {
      console.error("❌ Debug error:", error);
      return res.status(500).json({
        status: "❌ ERROR",
        error: error.message
      });
    }
  });

  // Helper function to diagnose the issue
  function getDiagnosis(schedules, allSchedules, enrolledSubjectIds, subjectDetails) {
    if (!schedules || schedules.length === 0) {
      if (!allSchedules || allSchedules.length === 0) {
        return "❌ NO SCHEDULES EXIST for this program and year level. Admin needs to create schedules first.";
      } else {
        const scheduledSubjectIds = allSchedules.map(s => s.subject_id);
        const missingSchedules = enrolledSubjectIds.filter(id => !scheduledSubjectIds.includes(id));

        if (missingSchedules.length === enrolledSubjectIds.length) {
          return `❌ SCHEDULES EXIST for this program/year, but NONE match the student's enrolled subjects. Student is enrolled in subjects that don't have schedules yet. Missing schedules for subject IDs: ${missingSchedules.join(", ")}`;
        } else {
          return `⚠️ PARTIAL MATCH: Some enrolled subjects have schedules, but ${missingSchedules.length} subjects are missing schedules. Missing subject IDs: ${missingSchedules.join(", ")}`;
        }
      }
    } else {
      return `✅ SCHEDULES FOUND: ${schedules.length} schedule(s) match the student's enrolled subjects.`;
    }
  }

  // ============================================
  // ADMIN SCHEDULE MANAGEMENT ENDPOINTS (New)
  // ============================================

  /**
   * GET /course/schedules
   * Get all schedules (for admin schedule management page)
   * Returns flattened format: one record per day
   */
  router.get("/", async (req, res) => {
    const { programId, yearLevel, semesterId } = req.query;

    try {
      console.log('Fetching all schedules for admin view');

      // Build query
      let query = supabase
        .from("course_schedules")
        .select(`
          schedule_id,
          subject_id,
          program_id,
          year_level,
          batch,
          start_time,
          end_time,
          room,
          teacher_id,
          semester_id,
          course_subjects (
            subject_code,
            subject_name,
            units
          ),
          schedule_day_mapping (
            day_of_week
          )
        `);

      // Apply filters
      if (programId) {
        query = query.eq("program_id", programId);
      }
      if (yearLevel) {
        query = query.eq("year_level", yearLevel);
      }
      if (semesterId) {
        query = query.eq("semester_id", semesterId);
      }

      // Order results
      query = query
        .order("program_id", { ascending: true })
        .order("year_level", { ascending: true });

      const { data: schedules, error } = await query;

      if (error) {
        console.error('Error fetching schedules:', error);
        throw error;
      }

      console.log(`Fetched ${schedules.length} schedule records`);

      // Transform: Create one record per day (flattened format)
      const flattenedSchedules = [];

      schedules.forEach((schedule) => {
        const days = schedule.schedule_day_mapping || [];

        if (days.length > 0) {
          // Create separate record for each day
          days.forEach((dayMapping) => {
            flattenedSchedules.push({
              id: schedule.schedule_id,
              courseId: schedule.program_id,
              yearLevel: schedule.year_level,
              batch: schedule.batch,
              day: dayMapping.day_of_week,        // Single day
              startTime: schedule.start_time,
              endTime: schedule.end_time,
              room: schedule.room,
              teacher_id: schedule.teacher_id,
              subject_id: schedule.subject_id,
              code: schedule.course_subjects?.subject_code || 'N/A',
              subject: schedule.course_subjects?.subject_name || 'Unknown Subject',
              units: schedule.course_subjects?.units || 0
            });
          });
        } else {
          // Handle schedule with no days (shouldn't happen, but be safe)
          flattenedSchedules.push({
            id: schedule.schedule_id,
            courseId: schedule.program_id,
            yearLevel: schedule.year_level,
            batch: schedule.batch,
            day: null,
            startTime: schedule.start_time,
            endTime: schedule.end_time,
            room: schedule.room,
            teacher_id: schedule.teacher_id,
            subject_id: schedule.subject_id,
            code: schedule.course_subjects?.subject_code || 'N/A',
            subject: schedule.course_subjects?.subject_name || 'Unknown Subject',
            units: schedule.course_subjects?.units || 0
          });
        }
      });

      console.log(`Returning ${flattenedSchedules.length} flattened records`);

      res.json(flattenedSchedules);

    } catch (error) {
      console.error("Error in GET /course/schedules:", error);
      res.status(500).json({
        error: "Failed to fetch schedules",
        details: error.message,
      });
    }
  });

  /**
   * POST /course/schedules
   * Create new schedule (admin only)
   * Expects days as an array
   */
  router.post("/", async (req, res) => {
    const {
      subjectId,
      programId,
      yearLevel,
      batch,
      startTime,
      endTime,
      room,
      teacherId,
      days,  // Array of days
      semesterId
    } = req.body;

    try {
      console.log('Creating new schedule:', req.body);

      // Validate required fields
      if (!subjectId || !programId || !yearLevel || !startTime || !endTime || !room) {
        return res.status(400).json({
          error: "Missing required fields",
          required: ["subjectId", "programId", "yearLevel", "startTime", "endTime", "room"]
        });
      }

      if (!days || !Array.isArray(days) || days.length === 0) {
        return res.status(400).json({
          error: "Days must be a non-empty array"
        });
      }

      // Get active semester if not provided
      let targetSemesterId = semesterId;
      if (!targetSemesterId) {
        const { data: activeSemester } = await supabase
          .from('semesters')
          .select('semester_id')
          .order('start_date', { ascending: false })
          .limit(1)
          .single();

        targetSemesterId = activeSemester?.semester_id;
      }

      // Step 1: Insert main schedule record
      const { data: scheduleData, error: insertError } = await supabase
        .from("course_schedules")
        .insert({
          subject_id: subjectId,
          program_id: programId,
          year_level: yearLevel,
          batch: batch || null,
          start_time: startTime,
          end_time: endTime,
          room,
          teacher_id: teacherId || null,
          semester_id: targetSemesterId
        })
        .select("schedule_id")
        .single();

      if (insertError) {
        console.error('Error inserting schedule:', insertError);
        throw insertError;
      }

      console.log('Schedule created with ID:', scheduleData.schedule_id);

      // Step 2: Insert day mappings
      const dayMappings = days.map(day => ({
        schedule_id: scheduleData.schedule_id,
        day_of_week: day
      }));

      const { error: dayError } = await supabase
        .from("schedule_day_mapping")
        .insert(dayMappings);

      if (dayError) {
        console.error('Error inserting day mappings:', dayError);
        // Rollback: delete the schedule
        await supabase
          .from("course_schedules")
          .delete()
          .eq("schedule_id", scheduleData.schedule_id);
        throw dayError;
      }

      console.log('Day mappings inserted successfully');

      // Fetch the complete created schedule
      const { data: completeSchedule, error: fetchError } = await supabase
        .from("course_schedules")
        .select(`
          schedule_id,
          subject_id,
          program_id,
          year_level,
          batch,
          start_time,
          end_time,
          room,
          teacher_id,
          semester_id,
          course_subjects (
            subject_code,
            subject_name,
            units
          ),
          schedule_day_mapping (
            day_of_week
          )
        `)
        .eq("schedule_id", scheduleData.schedule_id)
        .single();

      if (fetchError) throw fetchError;

      // Format response
      const response = {
        success: true,
        message: "Schedule created successfully",
        data: {
          schedule_id: completeSchedule.schedule_id,
          subject_id: completeSchedule.subject_id,
          subject_code: completeSchedule.course_subjects?.subject_code,
          subject_name: completeSchedule.course_subjects?.subject_name,
          program_id: completeSchedule.program_id,
          year_level: completeSchedule.year_level,
          batch: completeSchedule.batch,
          start_time: completeSchedule.start_time,
          end_time: completeSchedule.end_time,
          room: completeSchedule.room,
          teacher_id: completeSchedule.teacher_id,
          semester_id: completeSchedule.semester_id,
          days: completeSchedule.schedule_day_mapping?.map(d => d.day_of_week) || []
        }
      };

      res.status(201).json(response);

    } catch (error) {
      console.error("Error creating schedule:", error);
      res.status(500).json({
        error: "Failed to create schedule",
        details: error.message,
      });
    }
  });

  /**
   * GET /course/schedules/:id
   * Get single schedule by ID (for editing)
   */
  router.get("/:id", async (req, res) => {
    const { id } = req.params;

    try {
      console.log(`Fetching schedule ${id}`);

      const { data: schedule, error } = await supabase
        .from("course_schedules")
        .select(`
          schedule_id,
          subject_id,
          program_id,
          year_level,
          batch,
          start_time,
          end_time,
          room,
          teacher_id,
          semester_id,
          course_subjects (
            subject_code,
            subject_name,
            units
          ),
          teachers (
            teacher_id,
            first_name,
            last_name
          ),
          schedule_day_mapping (
            day_of_week
          )
        `)
        .eq("schedule_id", id)
        .single();

      if (error) {
        console.error('Error fetching schedule:', error);
        if (error.code === 'PGRST116') {
          return res.status(404).json({
            success: false,
            message: "Schedule not found"
          });
        }
        throw error;
      }

      // Get program details
      const { data: program } = await supabase
        .from("programs")
        .select("program_code, program_name")
        .eq("program_id", schedule.program_id)
        .single();

      // Format response
      const response = {
        success: true,
        data: {
          schedule_id: schedule.schedule_id,
          subject_id: schedule.subject_id,
          subject_code: schedule.course_subjects?.subject_code,
          subject_name: schedule.course_subjects?.subject_name,
          program_id: schedule.program_id,
          program_code: program?.program_code,
          program_name: program?.program_name,
          year_level: schedule.year_level,
          batch: schedule.batch,
          start_time: schedule.start_time,
          end_time: schedule.end_time,
          room: schedule.room,
          teacher_id: schedule.teacher_id,
          teacher_name: schedule.teachers
            ? `${schedule.teachers.first_name} ${schedule.teachers.last_name}`.trim()
            : null,
          semester_id: schedule.semester_id,
          days: schedule.schedule_day_mapping?.map(d => d.day_of_week) || []
        }
      };

      res.json(response);

    } catch (error) {
      console.error("Error fetching schedule:", error);
      res.status(500).json({
        success: false,
        error: "Failed to fetch schedule",
        details: error.message,
      });
    }
  });

  /**
   * PUT /course/schedules/:id
   * Update existing schedule
   */
  router.put("/:id", async (req, res) => {
    const { id } = req.params;
    const {
      subjectId,
      programId,
      yearLevel,
      batch,
      startTime,
      endTime,
      room,
      teacherId,
      days,
      semesterId
    } = req.body;

    try {
      console.log(`Updating schedule ${id}:`, req.body);

      // Check if schedule exists
      const { data: existing, error: checkError } = await supabase
        .from("course_schedules")
        .select("schedule_id")
        .eq("schedule_id", id)
        .single();

      if (checkError || !existing) {
        return res.status(404).json({
          success: false,
          message: "Schedule not found"
        });
      }

      // Validate days if provided
      if (days && (!Array.isArray(days) || days.length === 0)) {
        return res.status(400).json({
          success: false,
          message: "Days must be a non-empty array"
        });
      }

      // Build update object (only update provided fields)
      const updateData = {};
      if (subjectId !== undefined) updateData.subject_id = subjectId;
      if (programId !== undefined) updateData.program_id = programId;
      if (yearLevel !== undefined) updateData.year_level = yearLevel;
      if (batch !== undefined) updateData.batch = batch;
      if (startTime !== undefined) updateData.start_time = startTime;
      if (endTime !== undefined) updateData.end_time = endTime;
      if (room !== undefined) updateData.room = room;
      if (teacherId !== undefined) updateData.teacher_id = teacherId;
      if (semesterId !== undefined) updateData.semester_id = semesterId;

      // Step 1: Update main schedule
      const { error: updateError } = await supabase
        .from("course_schedules")
        .update(updateData)
        .eq("schedule_id", id);

      if (updateError) {
        console.error('Error updating schedule:', updateError);
        throw updateError;
      }

      console.log('Schedule updated successfully');

      // Step 2: Update days if provided
      if (days) {
        // Delete existing day mappings
        const { error: deleteError } = await supabase
          .from("schedule_day_mapping")
          .delete()
          .eq("schedule_id", id);

        if (deleteError) {
          console.error('Error deleting old day mappings:', deleteError);
          throw deleteError;
        }

        // Insert new day mappings
        const dayMappings = days.map(day => ({
          schedule_id: parseInt(id),
          day_of_week: day
        }));

        const { error: insertError } = await supabase
          .from("schedule_day_mapping")
          .insert(dayMappings);

        if (insertError) {
          console.error('Error inserting new day mappings:', insertError);
          throw insertError;
        }

        console.log('Day mappings updated successfully');
      }

      // Fetch updated schedule
      const { data: updatedSchedule, error: fetchError } = await supabase
        .from("course_schedules")
        .select(`
          schedule_id,
          subject_id,
          program_id,
          year_level,
          batch,
          start_time,
          end_time,
          room,
          teacher_id,
          semester_id,
          course_subjects (
            subject_code,
            subject_name,
            units
          ),
          schedule_day_mapping (
            day_of_week
          )
        `)
        .eq("schedule_id", id)
        .single();

      if (fetchError) throw fetchError;

      // Format response
      const response = {
        success: true,
        message: "Schedule updated successfully",
        data: {
          schedule_id: updatedSchedule.schedule_id,
          subject_id: updatedSchedule.subject_id,
          subject_code: updatedSchedule.course_subjects?.subject_code,
          subject_name: updatedSchedule.course_subjects?.subject_name,
          program_id: updatedSchedule.program_id,
          year_level: updatedSchedule.year_level,
          batch: updatedSchedule.batch,
          start_time: updatedSchedule.start_time,
          end_time: updatedSchedule.end_time,
          room: updatedSchedule.room,
          teacher_id: updatedSchedule.teacher_id,
          semester_id: updatedSchedule.semester_id,
          days: updatedSchedule.schedule_day_mapping?.map(d => d.day_of_week) || []
        }
      };

      res.json(response);

    } catch (error) {
      console.error("Error updating schedule:", error);
      res.status(500).json({
        success: false,
        error: "Failed to update schedule",
        details: error.message,
      });
    }
  });

  /**
   * DELETE /course/schedules/:id
   * Delete schedule and its day mappings
   */
  router.delete("/:id", async (req, res) => {
    const { id } = req.params;

    try {
      console.log(`Deleting schedule ${id}`);

      // Check if schedule exists
      const { data: existing, error: checkError } = await supabase
        .from("course_schedules")
        .select("schedule_id")
        .eq("schedule_id", id)
        .single();

      if (checkError || !existing) {
        return res.status(404).json({
          success: false,
          message: "Schedule not found"
        });
      }

      // Step 1: Delete day mappings first (foreign key constraint)
      const { error: dayError } = await supabase
        .from("schedule_day_mapping")
        .delete()
        .eq("schedule_id", id);

      if (dayError) {
        console.error('Error deleting day mappings:', dayError);
        throw dayError;
      }

      console.log('Day mappings deleted');

      // Step 2: Delete the schedule itself
      const { error: scheduleError } = await supabase
        .from("course_schedules")
        .delete()
        .eq("schedule_id", id);

      if (scheduleError) {
        console.error('Error deleting schedule:', scheduleError);
        throw scheduleError;
      }

      console.log('Schedule deleted successfully');

      res.json({
        success: true,
        message: "Schedule deleted successfully"
      });

    } catch (error) {
      console.error("Error deleting schedule:", error);
      res.status(500).json({
        success: false,
        error: "Failed to delete schedule",
        details: error.message,
      });
    }
  });

  return router;
}

module.exports = createSchedulesRouter;