// routes/schedules.js
const express = require("express");

function createSchedulesRouter(supabase) {
  const router = express.Router();

  // POST /schedules - Create a new schedule
  router.post("/", async (req, res) => {
    const {
      subject_id,
      subjectId,
      program_id,
      programId,
      year_level,
      yearLevel,
      batch,
      day_of_week,
      dayOfWeek,
      start_time,
      startTime,
      end_time,
      endTime,
      room,
      teacher_id,
      teacherId,
    } = req.body;

    try {
      // Insert the schedule - support both snake_case and camelCase
      const { data: insertData, error: insertError } = await supabase
        .from("course_schedules")
        .insert({
          subject_id: subject_id || subjectId,
          program_id: program_id || programId,
          year_level: year_level || yearLevel,
          batch,
          day_of_week: day_of_week || dayOfWeek,
          start_time: start_time || startTime,
          end_time: end_time || endTime,
          room,
          teacher_id: teacher_id || teacherId,
        })
        .select("schedule_id")
        .single();

      if (insertError) throw insertError;

      // Fetch the complete schedule with subject details
      const { data: schedule, error: fetchError } = await supabase
        .from("course_schedules")
        .select(
          `
          schedule_id,
          program_id,
          year_level,
          batch,
          day_of_week,
          start_time,
          end_time,
          room,
          teacher_id,
          course_subjects!inner (
            subject_id,
            subject_code,
            subject_name,
            units
          )
        `
        )
        .eq("schedule_id", insertData.schedule_id)
        .single();

      if (fetchError) throw fetchError;

      // Format response
      const formattedSchedule = {
        schedule_id: schedule.schedule_id,
        program_id: schedule.program_id,
        year_level: schedule.year_level,
        batch: schedule.batch,
        day: schedule.day_of_week,
        start_time: schedule.start_time,
        end_time: schedule.end_time,
        room: schedule.room,
        teacher_id: schedule.teacher_id,
        subject_id: schedule.course_subjects.subject_id,
        code: schedule.course_subjects.subject_code,
        subject: schedule.course_subjects.subject_name,
        units: schedule.course_subjects.units,
      };

      res.status(201).json(formattedSchedule);
    } catch (error) {
      console.error("Error creating schedule:", error);
      res.status(500).json({
        error: "Failed to create schedule",
        details: error.message,
      });
    }
  });

  // GET /schedules - Get all schedules with filters
  router.get("/", async (req, res) => {
    const { programId, yearLevel } = req.query;

    try {
      let query = supabase.from("course_schedules").select(`
          schedule_id,
          program_id,
          year_level,
          batch,
          day_of_week,
          start_time,
          end_time,
          room,
          teacher_id,
          course_subjects!inner (
            subject_id,
            subject_code,
            subject_name,
            units
          )
        `);

      if (programId) {
        query = query.eq("program_id", programId);
      }
      if (yearLevel) {
        query = query.eq("year_level", yearLevel);
      }

      query = query
        .order("year_level", { ascending: true })
        .order("day_of_week", { ascending: true })
        .order("start_time", { ascending: true });

      const { data, error } = await query;

      if (error) throw error;

      // Format response
      const formattedSchedules = data.map((schedule) => ({
        id: schedule.schedule_id,
        courseId: schedule.program_id,
        yearLevel: schedule.year_level,
        batch: schedule.batch,
        day: schedule.day_of_week,
        startTime: schedule.start_time,
        endTime: schedule.end_time,
        room: schedule.room,
        teacher_id: schedule.teacher_id,
        subject_id: schedule.course_subjects.subject_id,
        code: schedule.course_subjects.subject_code,
        subject: schedule.course_subjects.subject_name,
        units: schedule.course_subjects.units,
      }));

      res.json(formattedSchedules);
    } catch (error) {
      console.error("Error fetching schedules:", error);
      res.status(500).json({
        error: "Failed to fetch schedules",
        details: error.message,
      });
    }
  });

  // GET /schedules/student/:studentId - Get schedule for a specific enrolled student
  router.get("/:studentId", async (req, res) => {
    const { studentId } = req.params;
    const { semesterId } = req.query; // Optional: filter by semester

    try {
      // First, get the student's active enrollment(s)
      let enrollmentQuery = supabase
        .from("enrollments")
        .select(
          `
        enrollment_id,
        program_id,
        semester_id,
        status,
        enrollment_subjects!inner (
          subject_id,
          status
        ),
        students!inner (
          student_id,
          year_level
        )
      `
        )
        .eq("student_id", studentId)
        .eq("status", "Enrolled")
        .eq("enrollment_subjects.status", "Enrolled");

      // Filter by semester if provided
      if (semesterId) {
        enrollmentQuery = enrollmentQuery.eq("semester_id", semesterId);
      }

      const { data: enrollments, error: enrollmentError } =
        await enrollmentQuery;

      if (enrollmentError) throw enrollmentError;

      if (!enrollments || enrollments.length === 0) {
        return res.status(404).json({
          error: "No active enrollment found for this student",
          message:
            "Student is not currently enrolled or has no enrolled subjects",
        });
      }

      // Get the first active enrollment (or you could handle multiple enrollments)
      const enrollment = enrollments[0];
      const yearLevel = enrollment.students.year_level;
      const programId = enrollment.program_id;

      // Extract subject IDs from enrolled subjects
      const enrolledSubjectIds = enrollment.enrollment_subjects.map(
        (es) => es.subject_id
      );

      if (enrolledSubjectIds.length === 0) {
        return res.json({
          message: "No subjects enrolled",
          schedule: [],
        });
      }

      // Fetch schedules for the enrolled subjects
      const { data: schedules, error: scheduleError } = await supabase
        .from("course_schedules")
        .select(
          `
        schedule_id,
        program_id,
        year_level,
        batch,
        day_of_week,
        start_time,
        end_time,
        room,
        subject_id,
        teacher_id,
        course_subjects!inner (
          subject_id,
          subject_code,
          subject_name,
          units,
          semester_id
        ),
        teachers (
          teacher_id,
          first_name,
          last_name,
          middle_name
        )
      `
        )
        .eq("program_id", programId)
        .eq("year_level", yearLevel)
        .in("subject_id", enrolledSubjectIds)
        .order("day_of_week", { ascending: true })
        .order("start_time", { ascending: true });

      if (scheduleError) throw scheduleError;

      // Format response
      const formattedSchedules = schedules.map((schedule) => ({
        id: schedule.schedule_id,
        courseId: schedule.program_id,
        yearLevel: schedule.year_level,
        batch: schedule.batch,
        day: schedule.day_of_week,
        startTime: schedule.start_time,
        endTime: schedule.end_time,
        room: schedule.room,
        subject: {
          id: schedule.course_subjects.subject_id,
          code: schedule.course_subjects.subject_code,
          name: schedule.course_subjects.subject_name,
          units: schedule.course_subjects.units,
          semesterId: schedule.course_subjects.semester_id,
        },
        teacher: schedule.teachers
          ? {
              id: schedule.teachers.teacher_id,
              name: `${schedule.teachers.first_name} ${
                schedule.teachers.middle_name
                  ? schedule.teachers.middle_name + " "
                  : ""
              }${schedule.teachers.last_name}`.trim(),
            }
          : null,
      }));

      // Group by day for easier frontend consumption (optional)
      const scheduleByDay = formattedSchedules.reduce((acc, schedule) => {
        if (!acc[schedule.day]) {
          acc[schedule.day] = [];
        }
        acc[schedule.day].push(schedule);
        return acc;
      }, {});

      res.json({
        studentId,
        enrollmentId: enrollment.enrollment_id,
        programId,
        yearLevel,
        semesterId: enrollment.semester_id,
        totalSubjects: enrolledSubjectIds.length,
        schedule: formattedSchedules,
        scheduleByDay,
      });
    } catch (error) {
      console.error("Error fetching student schedule:", error);
      res.status(500).json({
        error: "Failed to fetch student schedule",
        details: error.message,
      });
    }
  });

  // PUT /schedules/:id - Update schedule
  router.put("/:id", async (req, res) => {
    const { id } = req.params;
    const {
      subject_id,
      subjectId,
      program_id,
      programId,
      year_level,
      yearLevel,
      batch,
      day_of_week,
      dayOfWeek,
      start_time,
      startTime,
      end_time,
      endTime,
      room,
      teacher_id,
      teacherId,
    } = req.body;

    try {
      // Update the schedule - support both snake_case and camelCase
      const { error: updateError } = await supabase
        .from("course_schedules")
        .update({
          subject_id: subject_id || subjectId,
          program_id: program_id || programId,
          year_level: year_level || yearLevel,
          batch,
          day_of_week: day_of_week || dayOfWeek,
          start_time: start_time || startTime,
          end_time: end_time || endTime,
          room,
          teacher_id: teacher_id || teacherId,
        })
        .eq("schedule_id", id);

      if (updateError) throw updateError;

      // Fetch updated schedule
      const { data: schedule, error: fetchError } = await supabase
        .from("course_schedules")
        .select(
          `
          schedule_id,
          program_id,
          year_level,
          batch,
          day_of_week,
          start_time,
          end_time,
          room,
          teacher_id,
          course_subjects!inner (
            subject_id,
            subject_code,
            subject_name,
            units
          )
        `
        )
        .eq("schedule_id", id)
        .single();

      if (fetchError) throw fetchError;

      // Format response
      const formattedSchedule = {
        id: schedule.schedule_id,
        courseId: schedule.program_id,
        yearLevel: schedule.year_level,
        batch: schedule.batch,
        day: schedule.day_of_week,
        startTime: schedule.start_time,
        endTime: schedule.end_time,
        room: schedule.room,
        teacher_id: schedule.teacher_id,
        subject_id: schedule.course_subjects.subject_id,
        code: schedule.course_subjects.subject_code,
        subject: schedule.course_subjects.subject_name,
        units: schedule.course_subjects.units,
      };

      res.json(formattedSchedule);
    } catch (error) {
      console.error("Error updating schedule:", error);
      res.status(500).json({
        error: "Failed to update schedule",
        details: error.message,
      });
    }
  });

  // DELETE /schedules/:id - Delete schedule
  router.delete("/:id", async (req, res) => {
    const { id } = req.params;

    try {
      const { error } = await supabase
        .from("course_schedules")
        .delete()
        .eq("schedule_id", id);

      if (error) throw error;

      res.json({ message: "Schedule deleted successfully" });
    } catch (error) {
      console.error("Error deleting schedule:", error);
      res.status(500).json({
        error: "Failed to delete schedule",
        details: error.message,
      });
    }
  });

  return router;
}

module.exports = createSchedulesRouter;
