const express = require('express');

function tuitionnotifsRouter(supabase, logger) {
  const router = express.Router();

  // Get notifications for a student
  router.get('/:student_id', async (req, res) => {
    try {
      const { student_id } = req.params;
      const { limit = 10 } = req.query;

      const { data, error } = await supabase
        .from('student_notifications')
        .select('*')
        .eq('student_id', student_id)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) throw error;

      res.json({ 
        success: true, 
        notifications: data,
        unread_count: data.filter(n => !n.is_read).length
      });
    } catch (error) {
      logger.error('Error fetching notifications:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Mark notification as read
  router.patch('/:notification_id/read', async (req, res) => {
    try {
      const { notification_id } = req.params;

      const { error } = await supabase
        .from('student_notifications')
        .update({ is_read: true })
        .eq('notification_id', notification_id);

      if (error) throw error;

      res.json({ success: true });
    } catch (error) {
      logger.error('Error marking notification as read:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Mark all as read
  router.patch('/mark-all-read/:student_id', async (req, res) => {
    try {
      const { student_id } = req.params;

      const { error } = await supabase
        .from('student_notifications')
        .update({ is_read: true })
        .eq('student_id', student_id)
        .eq('is_read', false);

      if (error) throw error;

      res.json({ success: true });
    } catch (error) {
      logger.error('Error marking all as read:', error);
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}

module.exports = tuitionnotifsRouter;