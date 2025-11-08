const express = require('express');
const router = express.Router();
const scheduleController = require('../controllers/schedulecontroller');

// Create schedule
router.post('/create', scheduleController.createSchedule);

// Update schedule
router.put('/:id', scheduleController.updateSchedule);

// Check conflicts only
router.post('/check-conflicts', scheduleController.checkConflicts);

// Search schedules (must be before /:id)
router.get('/search', scheduleController.searchSchedules);

// Get by ID
router.get('/:id', scheduleController.getScheduleById);

// Delete schedule
router.delete('/:id', scheduleController.deleteSchedule);

module.exports = router;