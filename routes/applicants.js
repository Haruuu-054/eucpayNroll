const express = require("express");

function createApplicantsRouter(supabase) {
  const router = express.Router();

  // Fetching users - newest first (default)
  router.get("/", async (req, res) => {
    try {
      const { data, error } = await supabase
        .from("form_responses")
        .select(
          "firstname, middlename, lastname, timestamp, admission_id, preferred_course, applicant_status, email"
        )
        .order("timestamp", { ascending: false });

      if (error) throw error;

      if (data && data.length > 0) {
        res.json(data);
      } else {
        res.status(404).json({ msg: "No applicants found!" });
      }
    } catch (err) {
      console.error("Server error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Fetching total applicants count
  router.get("/num", async (req, res) => {
    try {
      const { count, error } = await supabase
        .from("form_responses")
        .select("*", { count: "exact", head: true });

      if (error) throw error;

      res.json({ total_applicants: count });
    } catch (err) {
      console.error("Server error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Fetching users - oldest first
  router.get("/old", async (req, res) => {
    try {
      const { data, error } = await supabase
        .from("form_responses")
        .select("firstname, middlename, lastname, timestamp")
        .order("timestamp", { ascending: true });

      if (error) throw error;

      if (data && data.length > 0) {
        res.json(data);
      } else {
        res.status(404).json({ msg: "No applicants found!" });
      }
    } catch (err) {
      console.error("Server error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Course-specific applicant counts
  const courseEndpoints = [
    { path: "compsci", course: "BS-Computer Science" },
    { path: "associate", course: "Associate in Computer Science" },
    { path: "coe", course: "BS-Computer Engineering" },
    { path: "nursing", course: "BS-Nursing" },
    { path: "psychology", course: "BS-Psychology" },
    { path: "accountancy", course: "BS-Accountancy" },
    { path: "tourism", course: "BS-Tourism Management" },
    { path: "hm", course: "BS-Hospitality Management" },
    { path: "educ", course: "BS-Education" },
  ];

  courseEndpoints.forEach(({ path, course }) => {
    router.get(`/preferred/${path}`, async (req, res) => {
      try {
        const { count, error } = await supabase
          .from("form_responses")
          .select("*", { count: "exact", head: true })
          .eq("preferred_course", course);

        if (error) throw error;

        res.json({ preferred_course: course, total_applicants: count });
      } catch (err) {
        console.error("Server error:", err.message);
        res.status(500).json({ error: err.message });
      }
    });
  });

  // Applicant details by admission ID
  router.get("/:admission_id", async (req, res) => {
    try {
      const { admission_id } = req.params;

      if (!admission_id) {
        return res.status(400).json({ error: "Admission ID is required" });
      }

      const { data, error } = await supabase
        .from("form_responses")
        .select(
          `
        firstname,
        lastname,
        middlename,
        suffix,
        birth_date,
        age,
        birth_place,
        gender,
        citizenship,
        civilstatus,
        religion, 
        ethnicity,
        last_school_attended,
        strand_taken,
        school_address,
        school_type,
        year_graduated,
        father,
        father_occupation,
        mother,
        mother_occupation,
        timestamp,
        parent_number,
        family_income,
        email,
        mobile_number,
        preferred_course,
        admission_id,
        alter_course_1, 
        alter_course_2,
        street,
        baranggay,
        municipality, 
        province,
        home_address,
        applicant_status
      `
        )
        .eq("admission_id", admission_id)
        .limit(1);

      if (error) throw error;

      if (data && data.length > 0) {
        res.json({
          exists: true,
          applicant: data[0],
        });
      } else {
        res.json({
          exists: false,
          message: "Applicant not found in registration database",
        });
      }
    } catch (err) {
      console.error("Server error in applicant-details:", err.message);
      res.status(500).json({
        error: "Failed to fetch applicant details",
        details: err.message,
      });
    }
  });

  // Get all uploaded files of an applicant
  router.get("/files/:admission_id", async (req, res) => {
    try {
      const { admission_id } = req.params;
      const applicantFolder = `applicant_${admission_id}`;

      async function listFilesRecursively(folderPath) {
        const { data: items, error } = await supabase.storage
          .from("uploads")
          .list(folderPath);

        if (error) {
          console.error(`Error listing files in ${folderPath}:`, error);
          return [];
        }

        let allFiles = [];

        for (const item of items) {
          if (item.id) {
            // It's a file
            allFiles.push(`${folderPath}/${item.name}`);
          } else if (item.name) {
            // It's a folder
            const subfolderFiles = await listFilesRecursively(
              `${folderPath}/${item.name}`
            );
            allFiles = allFiles.concat(subfolderFiles);
          }
        }

        return allFiles;
      }

      const filePaths = await listFilesRecursively(applicantFolder);

      if (filePaths.length === 0) {
        return res.json({
          message: "No files uploaded for this applicant",
          files: {},
        });
      }

      const results = {};
      for (const path of filePaths) {
        const { data: urlData, error: urlError } = await supabase.storage
          .from("uploads")
          .createSignedUrl(path, 3600);

        if (urlError) {
          console.error(`Error creating signed URL for ${path}:`, urlError);
          results[path] = null;
        } else {
          results[path] = urlData.signedUrl;
        }
      }

      res.json(results);
    } catch (err) {
      console.error("Server error:", err);
      res.status(500).json({ error: "Server error" });
    }
  });

  // Helper function for file retrieval
  async function getApplicantFile(admission_id, folderName, fileType) {
    const folderPath = `applicant_${admission_id}/${folderName}`;

    const { data: files, error } = await supabase.storage
      .from("uploads")
      .list(folderPath);

    if (error) throw error;

    if (!files || files.length === 0) {
      return null;
    }

    const file = files.find((f) => f.name && !f.id); // Find actual files

    if (!file) {
      return null;
    }

    const { data: publicUrlData } = supabase.storage
      .from("uploads")
      .getPublicUrl(`${folderPath}/${file.name}`);

    return publicUrlData.publicUrl;
  }

  // File retrieval endpoints
  const fileTypes = [
    { endpoint: "photo", folder: "applicant_uploads_2x2", name: "2x2 photo" },
    {
      endpoint: "transcript",
      folder: "applicant_uploads_transcript",
      name: "transcript",
    },
    {
      endpoint: "goodmoral",
      folder: "applicant_uploads_good_moral",
      name: "good moral",
    },
    {
      endpoint: "medical",
      folder: "applicant_uploads_medical_certificate",
      name: "medical certificate",
    },
    {
      endpoint: "birthcert",
      folder: "applicant_uploads_psa",
      name: "birth certificate",
    },
  ];

  fileTypes.forEach(({ endpoint, folder, name }) => {
    router.get(`/${endpoint}/:admission_id`, async (req, res) => {
      try {
        const { admission_id } = req.params;
        const url = await getApplicantFile(admission_id, folder, name);

        if (!url) {
          return res.status(404).json({
            success: false,
            message: `No ${name} found for this applicant.`,
          });
        }

        res.json({ success: true, url });
      } catch (err) {
        console.error(`Error fetching applicant ${name}:`, err.message);
        res
          .status(500)
          .json({ success: false, error: `Failed to fetch ${name}.` });
      }
    });
  });

  // ==================== DOCUMENT ENDPOINTS - FIXED ====================

  // Get applicant photo (2x2)
  router.get("/documents/:admission_id/photo", async (req, res) => {
    try {
      const { admission_id } = req.params;

      if (!admission_id) {
        return res.status(400).json({
          photo: null,
          message: "Admission ID is required",
        });
      }

      const filePath = `applicant_${admission_id}/applicant_uploads_2x2/2x2.jpg`;

      const { data } = supabase.storage.from("uploads").getPublicUrl(filePath);

      console.log("Generated photo URL:", data.publicUrl);

      res.json({ photo: data.publicUrl });
    } catch (error) {
      console.error("Error generating photo URL:", error);
      res.status(500).json({
        photo: null,
        message: "Error generating photo URL",
      });
    }
  });

  // Get applicant transcript
  router.get("/documents/:admission_id/transcript", async (req, res) => {
    try {
      const { admission_id } = req.params;

      if (!admission_id) {
        return res.status(400).json({
          transcript: null,
          message: "Admission ID is required",
        });
      }

      const filePath = `applicant_${admission_id}/applicant_uploads_transcript/transcript.jpg`;

      const { data } = supabase.storage.from("uploads").getPublicUrl(filePath);

      console.log("Generated transcript URL:", data.publicUrl);

      res.json({ transcript: data.publicUrl });
    } catch (error) {
      console.error("Error generating transcript URL:", error);
      res.status(500).json({
        transcript: null,
        message: "Error generating transcript URL",
      });
    }
  });

  // Get applicant good moral certificate
  router.get("/documents/:admission_id/good-moral", async (req, res) => {
    try {
      const { admission_id } = req.params;

      if (!admission_id) {
        return res.status(400).json({
          good_moral: null,
          message: "Admission ID is required",
        });
      }

      const filePath = `applicant_${admission_id}/applicant_uploads_good_moral/good_moral.jpg`;

      const { data } = supabase.storage.from("uploads").getPublicUrl(filePath);

      console.log("Generated good moral URL:", data.publicUrl);

      res.json({ good_moral: data.publicUrl });
    } catch (error) {
      console.error("Error generating good moral URL:", error);
      res.status(500).json({
        good_moral: null,
        message: "Error generating good moral URL",
      });
    }
  });

  // Get applicant PSA birth certificate
  router.get("/documents/:admission_id/psa", async (req, res) => {
    try {
      const { admission_id } = req.params;

      if (!admission_id) {
        return res.status(400).json({
          psa: null,
          message: "Admission ID is required",
        });
      }

      const filePath = `applicant_${admission_id}/applicant_uploads_psa/birth_certificate.jpg`;

      const { data } = supabase.storage.from("uploads").getPublicUrl(filePath);

      console.log("Generated PSA URL:", data.publicUrl);

      res.json({ psa: data.publicUrl });
    } catch (error) {
      console.error("Error generating PSA URL:", error);
      res.status(500).json({
        psa: null,
        message: "Error generating PSA URL",
      });
    }
  });

  // Get applicant medical certificate
  router.get(
    "/documents/:admission_id/medical-certificate",
    async (req, res) => {
      try {
        const { admission_id } = req.params;

        if (!admission_id) {
          return res.status(400).json({
            medical_certificate: null,
            message: "Admission ID is required",
          });
        }

        const filePath = `applicant_${admission_id}/applicant_uploads_medical_certificate/medical_certificate.jpg`;

        const { data } = supabase.storage
          .from("uploads")
          .getPublicUrl(filePath);

        console.log("Generated medical certificate URL:", data.publicUrl);

        res.json({ medical_certificate: data.publicUrl });
      } catch (error) {
        console.error("Error generating medical certificate URL:", error);
        res.status(500).json({
          medical_certificate: null,
          message: "Error generating medical certificate URL",
        });
      }
    }
  );

  // ==================== END DOCUMENT ENDPOINTS ====================

  // Update applicant status
  router.patch("/status/:admissionId", async (req, res) => {
    console.log("🔴 PATCH /status endpoint hit!");
    console.log("🔴 Params:", req.params);
    console.log("🔴 Body:", req.body);
    console.log("🔴 admissionId from params:", req.params.admissionId);

    const { admissionId } = req.params;
    const { status } = req.body;

    const validStatuses = ["accepted", "rejected", "on-hold", "pending"];
    if (!validStatuses.includes(status)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid status provided." });
    }

    try {
      const { data, error } = await supabase
        .from("form_responses")
        .update({ applicant_status: status })
        .eq("admission_id", admissionId)
        .select(); // 👈 force Supabase to return updated row(s)

      console.log("Supabase update result:", { data, error });

      if (error) {
        console.error("Supabase update error:", error);
        return res.status(500).json({
          success: false,
          message: "Failed to update applicant status.",
        });
      }

      if (!data || data.length === 0) {
        return res
          .status(404)
          .json({ success: false, message: "Applicant not found." });
      }

      res.json({
        success: true,
        message: "Applicant status updated successfully.",
        updated: data,
      });
    } catch (err) {
      console.error("Server error:", err);
      res
        .status(500)
        .json({ success: false, message: "Internal server error." });
    }
  });

  // Get applicant status by email
  router.get("/status", async (req, res) => {
    try {
      const { email } = req.query;

      if (!email) {
        return res.status(400).json({
          success: false,
          message: "Email is required.",
        });
      }

      const { data, error } = await supabase
        .from("form_responses")
        .select("applicant_status")
        .eq("email", email.toLowerCase())
        .limit(1);

      if (error) {
        console.error("Database fetch error:", error);
        return res.status(500).json({
          success: false,
          message: "Failed to fetch applicant status.",
        });
      }

      if (!data || data.length === 0) {
        return res.json({
          success: false,
          message: "Applicant not found.",
        });
      }

      res.json({
        success: true,
        status: data[0].applicant_status,
      });
    } catch (err) {
      console.error("Server error:", err.message);
      res.status(500).json({
        success: false,
        message: "Internal server error.",
      });
    }
  });

  return router;
}

module.exports = createApplicantsRouter;
