const express = require("express");

function createDepartmentsRouter(supabase) {
  const router = express.Router();

  router.post("/", async (req, res) => {
    const { department_name } = req.body;
    const { department_code } = req.body;

    if (!department_name || !department_code) {
      return res.status(400).json({ error: "All fields are required" });
    }

    const { data, error } = await supabase
      .from("departments")
      .insert([{ department_name, department_code }])
      .select();

    if (error) return res.status(400).json({ error: error.message });
    res.status(201).json(data);
  });

  router.get("/", async (req, res) => {
    const { data, error } = await supabase.from("departments").select("*");
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  });

  return router;
}

module.exports = createDepartmentsRouter;
