const express = require("express");
const sgMail = require("@sendgrid/mail");

function createEmailRouter(supabase) {
  const router = express.Router();

  // Initialize SendGrid API key
  const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
  const SENDGRID_FROM = process.env.SENDGRID_FROM;

  if (!SENDGRID_API_KEY) {
    console.warn("SENDGRID_API_KEY not set. Email endpoints will be disabled.");
  } else {
    sgMail.setApiKey(SENDGRID_API_KEY);
  }

  router.get("/test-email", async (req, res) => {
    try {
      if (!SENDGRID_API_KEY) {
        return res
          .status(500)
          .send(
            "SendGrid not configured. Set SENDGRID_API_KEY environment variable."
          );
      }
      if (!SENDGRID_FROM) {
        return res
          .status(500)
          .send(
            "Sender email not configured. Set SENDGRID_FROM to a verified sender in SendGrid."
          );
      }

      const to = req.query.to || "nicolereeyn8@gmail.com"; // allow overriding via ?to= 

      const msg = {
        to,
        from: SENDGRID_FROM, // must match a verified Single Sender or authenticated domain
        subject: "Test Email from SendGrid",
        text: "This is a test email sent from your Node.js app using SendGrid.",
        html: "<strong>This is a test email sent from your Node.js app using SendGrid.</strong>",
      };

      const [response] = await sgMail.send(msg);
      res.send(
        `Test email queued successfully to ${to}. SendGrid status: ${response && response.statusCode}`
      );
    } catch (error) {
      console.error(
        "Error sending test email:",
        error && error.message ? error.message : error
      );
      if (error && error.response && error.response.body) {
        console.error("SendGrid response body:", error.response.body);
        return res.status(500).json({
          message: "Failed to send test email.",
          sendgrid_error: error.response.body,
        });
      }
      res.status(500).send("Failed to send test email.");
    }
  });

  // Send email to a registered user by email
  router.post("/send-email", async (req, res) => {
    try {
      if (!SENDGRID_API_KEY) {
        return res.status(500).json({
          success: false,
          message: "SendGrid not configured. Set SENDGRID_API_KEY.",
        });
      }
      if (!SENDGRID_FROM) {
        return res.status(500).json({
          success: false,
          message: "Sender email not configured. Set SENDGRID_FROM.",
        });
      }

      const { email, subject, text, html } = req.body || {};
      if (!email) {
        return res.status(400).json({
          success: false,
          message: "'email' is required in request body.",
        });
      }

      const normalizedEmail = String(email).toLowerCase().trim();

      // ✅ Find the applicant by email
      const { data, error } = await supabase
        .from("form_responses")
        .select("admission_id, firstname, middlename, lastname, suffix, email")
        .eq("email", normalizedEmail)
        .limit(1);

      if (error) {
        console.error("Database fetch error:", error);
        return res.status(500).json({
          success: false,
          message: "Failed to verify recipient in database.",
        });
      }

      if (!data || data.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Recipient email not found in database.",
        });
      }

      const user = data[0];
      const fullName = `${user.firstname || ""} ${user.suffix || ""} ${user.middlename || ""} ${user.lastname || ""}`
        .replace(/\s+/g, " ")
        .trim();

      const msg = {
        to: normalizedEmail,
        from: SENDGRID_FROM,
        subject: subject || "Notification",
        text:
          text ||
          `Hello ${fullName || "applicant"},

This is a notification from the admissions system.`, 
        html:
          html ||
          `<p>Hello ${fullName || "applicant"},</p><p>This is a notification from the admissions system.</p>`,
      };

      // ✅ Send the email
      const [response] = await sgMail.send(msg);
      const messageId =
        response &&
        response.headers &&
        (response.headers["x-message-id"] ||
          response.headers["x-message-id".toLowerCase()]);

      // ✅ Save notification to DB
      const { error: insertError } = await supabase.from("notifications").insert([
        {
          admission_id: user.admission_id,
          message:
            text ||
            `Hello ${fullName || "applicant"}, This is a notification from the admissions system.`, 
        },
      ]);

      if (insertError) {
        console.error("Error saving notification:", insertError);
        return res.status(500).json({
          success: false,
          message: "Email sent, but failed to save notification in database.",
        });
      }

      return res.json({
        success: true,
        queued: true,
        to: normalizedEmail,
        admission_id: user.admission_id,
        statusCode: response && response.statusCode,
        messageId,
        savedToDb: true,
      });
    } catch (err) {
      console.error(
        "Error sending email to user:",
        err && err.message ? err.message : err
      );
      if (err && err.response && err.response.body) {
        return res.status(500).json({
          success: false,
          message: "Failed to send email.",
          sendgrid_error: err.response.body,
        });
      }
      return res
        .status(500)
        .json({ success: false, message: "Failed to send email." });
    }
  });

  return router;
}

module.exports = createEmailRouter;