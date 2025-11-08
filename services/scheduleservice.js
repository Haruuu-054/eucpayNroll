const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase client directly
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

class ScheduleService {

    /**
     * Check for schedule conflicts
     */
    async checkConflicts(room, days, startTime, endTime, programId, yearLevel) {
        try {
            // Call the PostgreSQL function
            const { data, error } = await supabase.rpc('check_schedule_conflicts', {
                p_room: room,
                p_days: days,
                p_start_time: startTime,
                p_end_time: endTime,
                p_program_id: programId,
                p_year_level: yearLevel
            });

            if (error) {
                console.error('Error checking conflicts:', error);
                throw error;
            }

            return data || [];
        } catch (error) {
            console.error('Error in checkConflicts:', error);
            throw error;
        }
    }

    /**
     * Insert schedule (step 1)
     */
    async insertSchedule(scheduleData) {
        try {
            const { data, error } = await supabase
                .from('course_schedules')
                .insert({
                    subject_id: scheduleData.subjectId,
                    program_id: scheduleData.programId,
                    year_level: scheduleData.yearLevel,
                    batch: scheduleData.batch,
                    start_time: scheduleData.startTime,
                    end_time: scheduleData.endTime,
                    room: scheduleData.room,
                    teacher_id: scheduleData.teacherId
                })
                .select('schedule_id')
                .single();

            if (error) {
                console.error('Error inserting schedule:', error);
                throw error;
            }

            console.log('Schedule created with ID:', data.schedule_id);
            return data.schedule_id;
        } catch (error) {
            console.error('Error in insertSchedule:', error);
            throw error;
        }
    }

    /**
     * Insert schedule days (step 2)
     */
    async insertScheduleDays(scheduleId, days) {
        try {
            // Prepare data for bulk insert
            const dayMappings = days.map(day => ({
                schedule_id: scheduleId,
                day_of_week: day
            }));

            const { error } = await supabase
                .from('schedule_day_mapping')
                .insert(dayMappings);

            if (error) {
                console.error('Error inserting schedule days:', error);
                throw error;
            }

            console.log('Schedule days inserted successfully');
            return true;
        } catch (error) {
            console.error('Error in insertScheduleDays:', error);
            throw error;
        }
    }

    /**
     * Get schedule by ID
     */
    async getScheduleById(scheduleId) {
        try {
            const { data, error } = await supabase
                .from('course_schedules')
                .select(`
          schedule_id,
          subject_id,
          course_subjects (
            subject_code,
            subject_name
          ),
          program_id,
          year_level,
          batch,
          start_time,
          end_time,
          room,
          teacher_id,
          teachers (
            first_name,
            last_name
          ),
          schedule_day_mapping (
            day_of_week
          )
        `)
                .eq('schedule_id', scheduleId)
                .single();

            if (error) {
                console.error('Error fetching schedule:', error);
                throw error;
            }

            if (!data) {
                return null;
            }

            // Get program code separately
            const { data: programData } = await supabase
                .from('programs')
                .select('program_code, program_name')
                .eq('program_id', data.program_id)
                .single();

            // Format the response
            return {
                schedule_id: data.schedule_id,
                subject_id: data.subject_id,
                subject_code: data.course_subjects?.subject_code,
                subject_name: data.course_subjects?.subject_name,
                program_id: data.program_id,
                program_code: programData?.program_code,
                program_name: programData?.program_name,
                year_level: data.year_level,
                batch: data.batch,
                start_time: data.start_time,
                end_time: data.end_time,
                room: data.room,
                teacher_id: data.teacher_id,
                teacher_name: data.teachers
                    ? `${data.teachers.first_name} ${data.teachers.last_name}`
                    : 'No Teacher',
                days: data.schedule_day_mapping?.map(d => d.day_of_week) || []
            };
        } catch (error) {
            console.error('Error in getScheduleById:', error);
            throw error;
        }
    }

    /**
     * Search schedules with filters
     */
    async searchSchedules(filters) {
        try {
            let query = supabase
                .from('course_schedules')
                .select(`
        schedule_id,
        subject_id,
        course_subjects (
          subject_code,
          subject_name
        ),
        program_id,
        year_level,
        batch,
        start_time,
        end_time,
        room,
        teacher_id,
        teachers (
          first_name,
          last_name
        ),
        schedule_day_mapping (
          day_of_week
        )
      `);

            // Apply filters (same as before)
            if (filters.subjectId) query = query.eq('subject_id', filters.subjectId);
            // ... other filters

            const { data, error } = await query;
            if (error) throw error;

            // Get program codes (same as before)
            const programIds = [...new Set(data.map(s => s.program_id))];
            const { data: programsData } = await supabase
                .from('programs')
                .select('program_id, program_code')
                .in('program_id', programIds);
            const programMap = {};
            programsData?.forEach(p => programMap[p.program_id] = p.program_code);

            // **Key Change: Do NOT flatten by days. Keep one entry per schedule.**
            const formattedData = data.map(schedule => ({
                schedule_id: schedule.schedule_id,
                subject_code: schedule.course_subjects?.subject_code,
                subject_name: schedule.course_subjects?.subject_name,
                program_id: schedule.program_id,
                program_code: programMap[schedule.program_id] || null,
                year_level: schedule.year_level,
                batch: schedule.batch,
                start_time: schedule.start_time,
                end_time: schedule.end_time,
                room: schedule.room,
                teacher_id: schedule.teacher_id,
                teacher_name: schedule.teachers
                    ? `${schedule.teachers.first_name} ${schedule.teachers.last_name}`
                    : 'No Teacher',
                // **Consolidate days into an array**
                days: schedule.schedule_day_mapping?.map(d => d.day_of_week) || []
            }));

            return formattedData;
        } catch (error) {
            console.error('Error in searchSchedules:', error);
            throw error;
        }
    }

    /**
     * Delete schedule
     */
    async deleteSchedule(scheduleId) {
        try {
            // First delete day mappings
            const { error: dayError } = await supabase
                .from('schedule_day_mapping')
                .delete()
                .eq('schedule_id', scheduleId);

            if (dayError) {
                console.error('Error deleting schedule days:', dayError);
                throw dayError;
            }

            // Then delete the schedule
            const { error: scheduleError } = await supabase
                .from('course_schedules')
                .delete()
                .eq('schedule_id', scheduleId);

            if (scheduleError) {
                console.error('Error deleting schedule:', scheduleError);
                throw scheduleError;
            }

            console.log('Schedule deleted successfully');
            return true;
        } catch (error) {
            console.error('Error in deleteSchedule:', error);
            throw error;
        }
    }

    /**
     * Update schedule
     */
    async updateSchedule(scheduleId, scheduleData) {
        try {
            const updateData = {};
            if (scheduleData.subjectId) updateData.subject_id = scheduleData.subjectId;
            if (scheduleData.programId) updateData.program_id = scheduleData.programId;
            if (scheduleData.yearLevel) updateData.year_level = scheduleData.yearLevel;
            if (scheduleData.batch !== undefined) updateData.batch = scheduleData.batch;
            if (scheduleData.startTime) updateData.start_time = scheduleData.startTime;
            if (scheduleData.endTime) updateData.end_time = scheduleData.endTime;
            if (scheduleData.room) updateData.room = scheduleData.room;
            if (scheduleData.teacherId) updateData.teacher_id = scheduleData.teacherId;

            const { error } = await supabase
                .from('course_schedules')
                .update(updateData)
                .eq('schedule_id', scheduleId);

            if (error) {
                console.error('Error updating schedule:', error);
                throw error;
            }

            console.log('Schedule updated successfully');
            return true;
        } catch (error) {
            console.error('Error in updateSchedule:', error);
            throw error;
        }
    }

    /**
     * Update schedule days
     */
    async updateScheduleDays(scheduleId, days) {
        try {
            // Delete existing days
            await supabase
                .from('schedule_day_mapping')
                .delete()
                .eq('schedule_id', scheduleId);

            // Insert new days
            const dayMappings = days.map(day => ({
                schedule_id: scheduleId,
                day_of_week: day
            }));

            const { error } = await supabase
                .from('schedule_day_mapping')
                .insert(dayMappings);

            if (error) {
                console.error('Error updating schedule days:', error);
                throw error;
            }

            console.log('Schedule days updated successfully');
            return true;
        } catch (error) {
            console.error('Error in updateScheduleDays:', error);
            throw error;
        }
    }
}

module.exports = new ScheduleService();