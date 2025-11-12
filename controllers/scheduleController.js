const scheduleService = require('../services/scheduleservice');

class ScheduleController {
  
  /**
   * POST /api/schedules/create
   * Create schedule manually (2 steps)
   * Now includes semester_id (defaults to active semester if not provided)
   */
  async createSchedule(req, res) {
    try {
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
        semesterId, // Optional: defaults to active semester
        skipConflictCheck
      } = req.body;
      
      // Validate required fields
      if (!subjectId || !programId || !yearLevel || !startTime || !endTime || !room || !days) {
        return res.status(400).json({
          success: false,
          message: 'Missing required fields'
        });
      }

      // Validate days array
      if (!Array.isArray(days) || days.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Days must be a non-empty array'
        });
      }
      
      // Get active semester if not provided
      let targetSemesterId = semesterId;
      if (!targetSemesterId) {
        const activeSemester = await scheduleService.getActiveSemester();
        targetSemesterId = activeSemester.semester_id;
      }
      
      // Check for conflicts (unless skipped)
      if (!skipConflictCheck) {
        const conflicts = await scheduleService.checkConflicts(
          room,
          days,
          startTime,
          endTime,
          programId,
          yearLevel,
          targetSemesterId
        );
        
        if (conflicts.length > 0) {
          return res.status(409).json({
            success: false,
            message: 'Schedule conflicts detected',
            conflicts: conflicts
          });
        }
      }
      
      // Step 1: Insert schedule
      const scheduleId = await scheduleService.insertSchedule({
        subjectId,
        programId,
        yearLevel,
        batch,
        startTime,
        endTime,
        room,
        teacherId,
        semesterId: targetSemesterId
      });
      
      // Step 2: Insert days
      await scheduleService.insertScheduleDays(scheduleId, days);
      
      // Fetch the created schedule
      const schedule = await scheduleService.getScheduleById(scheduleId);
      
      return res.status(201).json({
        success: true,
        message: 'Schedule created successfully',
        data: schedule
      });
      
    } catch (error) {
      console.error('Error creating schedule:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to create schedule',
        error: error.message
      });
    }
  }
  
  /**
   * PUT /api/schedules/:id
   * Update existing schedule
   */
  async updateSchedule(req, res) {
    try {
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
        semesterId,
        skipConflictCheck
      } = req.body;
      
      // Check if schedule exists
      const existingSchedule = await scheduleService.getScheduleById(id);
      if (!existingSchedule) {
        return res.status(404).json({
          success: false,
          message: 'Schedule not found'
        });
      }

      // Validate days array if provided
      if (days && (!Array.isArray(days) || days.length === 0)) {
        return res.status(400).json({
          success: false,
          message: 'Days must be a non-empty array'
        });
      }
      
      // Check for conflicts if critical fields are being updated
      if (!skipConflictCheck && (room || days || startTime || endTime)) {
        const conflicts = await scheduleService.checkConflicts(
          room || existingSchedule.room,
          days || existingSchedule.days,
          startTime || existingSchedule.start_time,
          endTime || existingSchedule.end_time,
          programId || existingSchedule.program_id,
          yearLevel || existingSchedule.year_level,
          semesterId || existingSchedule.semester_id,
          id // Exclude current schedule
        );
        
        if (conflicts.length > 0) {
          return res.status(409).json({
            success: false,
            message: 'Schedule conflicts detected',
            conflicts: conflicts
          });
        }
      }
      
      // Step 1: Update schedule
      await scheduleService.updateSchedule(id, {
        subjectId,
        programId,
        yearLevel,
        batch,
        startTime,
        endTime,
        room,
        teacherId,
        semesterId
      });
      
      // Step 2: Update days if provided
      if (days) {
        await scheduleService.updateScheduleDays(id, days);
      }
      
      // Fetch the updated schedule
      const schedule = await scheduleService.getScheduleById(id);
      
      return res.status(200).json({
        success: true,
        message: 'Schedule updated successfully',
        data: schedule
      });
      
    } catch (error) {
      console.error('Error updating schedule:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to update schedule',
        error: error.message
      });
    }
  }
  
  /**
   * POST /api/schedules/check-conflicts
   * Just check for conflicts without creating
   */
  async checkConflicts(req, res) {
    try {
      const { room, days, startTime, endTime, programId, yearLevel, semesterId, excludeScheduleId } = req.body;
      
      if (!room || !days || !startTime || !endTime) {
        return res.status(400).json({
          success: false,
          message: 'Missing required fields: room, days, startTime, endTime'
        });
      }

      if (!Array.isArray(days) || days.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Days must be a non-empty array'
        });
      }
      
      // Get active semester if not provided
      let targetSemesterId = semesterId;
      if (!targetSemesterId) {
        const activeSemester = await scheduleService.getActiveSemester();
        targetSemesterId = activeSemester.semester_id;
      }
      
      const conflicts = await scheduleService.checkConflicts(
        room,
        days,
        startTime,
        endTime,
        programId,
        yearLevel,
        targetSemesterId,
        excludeScheduleId
      );
      
      return res.status(200).json({
        success: true,
        hasConflicts: conflicts.length > 0,
        count: conflicts.length,
        conflicts: conflicts
      });
      
    } catch (error) {
      console.error('Error checking conflicts:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to check conflicts',
        error: error.message
      });
    }
  }
  
  /**
   * GET /api/schedules/search
   * Search schedules with filters
   * Now supports semester filtering (defaults to active semester)
   */
  async searchSchedules(req, res) {
    try {
      const filters = {
        subjectId: req.query.subjectId,
        programId: req.query.programId,
        yearLevel: req.query.yearLevel,
        room: req.query.room,
        teacherId: req.query.teacherId,
        semesterId: req.query.semesterId // Optional: defaults to active semester
      };
      
      const schedules = await scheduleService.searchSchedules(filters);
      
      return res.status(200).json({
        success: true,
        count: schedules.length,
        data: schedules
      });
      
    } catch (error) {
      console.error('Error searching schedules:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to search schedules',
        error: error.message
      });
    }
  }
  
  /**
   * GET /api/schedules/:id
   * Get single schedule by ID
   */
  async getScheduleById(req, res) {
    try {
      const { id } = req.params;
      
      const schedule = await scheduleService.getScheduleById(id);
      
      if (!schedule) {
        return res.status(404).json({
          success: false,
          message: 'Schedule not found'
        });
      }
      
      return res.status(200).json({
        success: true,
        data: schedule
      });
      
    } catch (error) {
      console.error('Error getting schedule:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to get schedule',
        error: error.message
      });
    }
  }
  
  /**
   * DELETE /api/schedules/:id
   * Delete schedule by ID
   */
  async deleteSchedule(req, res) {
    try {
      const { id } = req.params;
      
      // Check if schedule exists
      const schedule = await scheduleService.getScheduleById(id);
      if (!schedule) {
        return res.status(404).json({
          success: false,
          message: 'Schedule not found'
        });
      }
      
      await scheduleService.deleteSchedule(id);
      
      return res.status(200).json({
        success: true,
        message: 'Schedule deleted successfully'
      });
      
    } catch (error) {
      console.error('Error deleting schedule:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to delete schedule',
        error: error.message
      });
    }
  }

  /**
   * GET /api/schedules/semesters/active
   * Get the active semester
   */
  async getActiveSemester(req, res) {
    try {
      const activeSemester = await scheduleService.getActiveSemester();
      
      return res.status(200).json({
        success: true,
        data: activeSemester
      });
      
    } catch (error) {
      console.error('Error getting active semester:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to get active semester',
        error: error.message
      });
    }
  }
}

module.exports = new ScheduleController();