// routes/courses.js
const express = require('express');

function createCoursesRouter(supabase) {
  const router = express.Router();

  // GET /programs - Get all programs with their subjects organized by year
  router.get('/', async (req, res) => {
    try {
      // Get all programs
      const { data: programs, error: programsError } = await supabase
        .from('programs')
        .select('*')
        .order('program_name', { ascending: true });

      if (programsError) throw programsError;

      // Get all subjects with their program associations and teachers
      const { data: subjects, error: subjectsError } = await supabase
        .from('course_subjects')
        .select(`
          subject_id,
          subject_code,
          subject_name,
          units,
          year_level,
          semester_id,
          subject_type,
          program_id,
          semesters(semester_name),
          teacher_subject_specializations(
            teacher_id,
            teachers(
              teacher_id,
              first_name,
              last_name,
              email
            )
          )
        `)
        .order('year_level', { ascending: true })
        .order('subject_code', { ascending: true });

      if (subjectsError) throw subjectsError;

      // Organize subjects by program and year level
      const programsWithSubjects = programs.map(program => {
        // Filter subjects for this program
        const programSubjects = subjects.filter(s => s.program_id === program.program_id);
        
        // Transform subjects to flatten teacher data
        const transformedSubjects = programSubjects.map(subject => ({
          subject_id: subject.subject_id,
          subject_code: subject.subject_code,
          subject_name: subject.subject_name,
          units: subject.units,
          year_level: subject.year_level,
          semester_id: subject.semester_id,
          semester_name: subject.semesters?.semester_name || null,
          subject_type: subject.subject_type,
          program_id: subject.program_id,
          teachers: subject.teacher_subject_specializations
            ?.map(tss => tss.teachers)
            .filter(t => t !== null) || []
        }));
        
        // Organize by year level
        const subjectsByYear = {
          1: transformedSubjects.filter(s => s.year_level === 1),
          2: transformedSubjects.filter(s => s.year_level === 2),
          3: transformedSubjects.filter(s => s.year_level === 3),
          4: transformedSubjects.filter(s => s.year_level === 4)
        };

        return {
          ...program,
          subjects_by_year: subjectsByYear,
          total_subjects: programSubjects.length
        };
      });

      res.json(programsWithSubjects);
    } catch (error) {
      console.error('Error fetching programs:', error);
      res.status(500).json({ 
        error: 'Failed to fetch programs',
        details: error.message
      });
    }
  });

  // GET /programs/:id - Get a specific program with subjects
  router.get('/:id', async (req, res) => {
    const { id } = req.params;

    try {
      // Get program
      const { data: program, error: programError } = await supabase
        .from('programs')
        .select('*')
        .eq('program_id', id)
        .single();

      if (programError) {
        if (programError.code === 'PGRST116') {
          return res.status(404).json({ error: 'Program not found' });
        }
        throw programError;
      }

      // Get subjects for this program with teachers
      const { data: subjects, error: subjectsError } = await supabase
        .from('course_subjects')
        .select(`
          subject_id,
          subject_code,
          subject_name,
          units,
          year_level,
          semester_id,
          subject_type,
          program_id,
          semesters(semester_name),
          teacher_subject_specializations(
            teacher_id,
            teachers(
              teacher_id,
              first_name,
              last_name,
              email
            )
          )
        `)
        .eq('program_id', id)
        .order('year_level', { ascending: true })
        .order('subject_code', { ascending: true });

      if (subjectsError) throw subjectsError;

      // Transform subjects to flatten teacher data
      const transformedSubjects = subjects.map(subject => ({
        subject_id: subject.subject_id,
        subject_code: subject.subject_code,
        subject_name: subject.subject_name,
        units: subject.units,
        year_level: subject.year_level,
        semester_id: subject.semester_id,
        semester_name: subject.semesters?.semester_name || null,
        subject_type: subject.subject_type,
        program_id: subject.program_id,
        teachers: subject.teacher_subject_specializations
          ?.map(tss => tss.teachers)
          .filter(t => t !== null) || []
      }));

      // Organize by year level
      const subjectsByYear = {
        1: transformedSubjects.filter(s => s.year_level === 1),
        2: transformedSubjects.filter(s => s.year_level === 2),
        3: transformedSubjects.filter(s => s.year_level === 3),
        4: transformedSubjects.filter(s => s.year_level === 4)
      };

      res.json({
        ...program,
        subjects_by_year: subjectsByYear,
        total_subjects: subjects.length
      });
    } catch (error) {
      console.error('Error fetching program:', error);
      res.status(500).json({ 
        error: 'Failed to fetch program',
        details: error.message
      });
    }
  });

  return router;
}

module.exports = createCoursesRouter;