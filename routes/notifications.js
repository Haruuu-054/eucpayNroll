const express = require("express");

function createNotificationsRouter(supabase) {
  const router = express.Router();

  // 📌 GET notifications by admission_id
  router.get("/:admission_id", async (req, res) => {
    try {
      const { admission_id } = req.params;
      const { page = 1, limit = 10 } = req.query; // allow ?page=2&limit=10
      const offset = (page - 1) * limit;

      const { data, error, count } = await supabase
        .from("notifications")
        .select("notification_id, message, is_read, created_at", {
          count: "exact",
        })
        .eq("admission_id", admission_id)
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) {
        console.error("Database fetch error:", error);
        return res
          .status(500)
          .json({ success: false, message: "Failed to fetch notifications." });
      }

      return res.json({
        success: true,
        admission_id,
        page: Number(page),
        limit: Number(limit),
        total: count,
        notifications: data || [],
      });
    } catch (err) {
      console.error("Error fetching notifications:", err.message || err);
      return res
        .status(500)
        .json({ success: false, message: "Internal server error." });
    }
  });

  return router;
}

module.exports = createNotificationsRouter;
