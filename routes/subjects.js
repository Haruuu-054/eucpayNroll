// routes/subjects.js
const express = require('express');

function createSubjectsRouter(supabase) {
  const router = express.Router();

  // GET /subjects - Get available subjects for dropdown
  router.get('/', async (req, res) => {
    const { programId, yearLevel } = req.query;

    if (!programId || !yearLevel) {
      return res.status(400).json({ 
        error: 'Both programId and yearLevel are required' 
      });
    }

    try {
      const { data, error } = await supabase
        .from('course_subjects')
        .select('subject_id, subject_code, subject_name, units, year_level')
        .eq('program_id', programId)
        .eq('year_level', yearLevel)
        .order('subject_code');

      if (error) throw error;

      // Transform to match expected format
      const subjects = data.map(subject => ({
        id: subject.subject_id,
        code: subject.subject_code,
        name: subject.subject_name,
        units: subject.units,
        yearLevel: subject.year_level
      }));

      res.json(subjects);
    } catch (error) {
      console.error('Error fetching subjects:', error);
      res.status(500).json({ 
        error: 'Failed to fetch subjects',
        details: error.message 
      });
    }
  });

  return router;
}

module.exports = createSubjectsRouter;