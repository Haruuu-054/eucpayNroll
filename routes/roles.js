const express = require("express");

function createRolesRouter(supabase) {
  const router = express.Router();

  router.get("/", async (req, res) => {
    const { data, error } = await supabase.from("roles").select("*");
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  });

  router.post("/", async (req, res) => {
    const { role_name } = req.body;

    if (!role_name) {
      return res.status(400).json({ error: "role_name is required" });
    }

    const { data, error } = await supabase
      .from("roles")
      .insert([{ role_name }])
      .select();

    if (error) return res.status(400).json({ error: error.message });
    res.status(201).json(data);
  });

  return router;
}

module.exports = createRolesRouter;
