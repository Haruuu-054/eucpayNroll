const express = require("express");

function createProgramsRouter(supabase) {
  const router = express.Router();

  router.post("/", async (req, res) => {
    const { program_code } = req.body;
    const { program_name } = req.body;
    const { department_id } = req.body;

    if (!program_code || !program_name || !department_id) {
      return res.status(400).json({ error: "All fields are required" });
    }

    const { data, error } = await supabase
      .from("programs")
      .insert([{ program_code, program_name, department_id }])
      .select();

    if (error) return res.status(400).json({ error: error.message });
    res.status(201).json(data);
  });

  router.get("/", async (req, res) => {
    const { data, error } = await supabase.from("programs").select("*");
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  });

  return router;
}

module.exports = createProgramsRouter;
