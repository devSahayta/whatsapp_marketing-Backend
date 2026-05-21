// routes/whatsappTemplateRoutes.js
import express from "express";
import multer from "multer";
import {
  createTemplate,
  createUploadSession,
  uploadBinaryToSession,
  checkTemplateStatus,
  listTemplates,
  sendTemplate,
  sendTemplateBulk,
  uploadMedia,
  listMedia,
  deleteMedia,
  listMetaTemplates,
  mediaProxy,
  mediaProxyUrl,
  getSingleMetaTemplate,
  deleteMetaTemplate,
  getBulkProgress,
  getTemplateById,
  getAllTemplates,
  getSupabaseUploadUrl,
  uploadBinaryFromStorage,
  uploadMediaFromStorage,
  updateTemplateMediaId,
  prepareMediaHeader,
} from "../controllers/whatsappTemplateController.js";
// import fetch from "node-fetch";

const upload = multer(); // in-memory buffer

const router = express.Router();

// CLEAN ENDPOINTS — easy to use
router.post("/create", createTemplate);
router.post("/create-upload-session", createUploadSession);
router.post("/upload-binary", upload.single("file"), uploadBinaryToSession);
router.post("/upload-media", upload.single("file"), uploadMedia);

// For direct upload to Supabase storage
router.post("/media/upload-url", getSupabaseUploadUrl);
router.post("/media/upload-binary-from-storage", uploadBinaryFromStorage);
router.post("/media/upload-media-from-storage", uploadMediaFromStorage);

// AI chat: prepare a media header — JSON body with storage_path (file already in Supabase)
router.post("/prepare-media-header", prepareMediaHeader);

// sending template;
router.post("/send/:templateId", sendTemplate);

//sending bulk template (more than one)
router.post("/send-bulk/:templateId", sendTemplateBulk);

router.get("/media/list", listMedia);
router.delete("/media/:media_id", deleteMedia);

//list all template from meta
router.get("/meta/list", listMetaTemplates);

//get single template details
router.get("/meta/template", getSingleMetaTemplate);
// router.get("/meta/template-name/:templateName", getMetaTemplateByName);

//get proxy url for uploaded media file
router.get("/media-proxy/:mediaId", mediaProxy);

//get url for the template placeholder image
router.get("/media-proxy-url", mediaProxyUrl);

//check template status
router.get("/:wt_id/status", checkTemplateStatus);
router.patch("/:wt_id/media-id", updateTemplateMediaId);
router.get("/", listTemplates);
router.get("/all", getAllTemplates);
router.get("/:wt_id", getTemplateById);

// DELETE template from Meta
router.delete("/meta/:templateId", deleteMetaTemplate);

// For getting bulk-progress of template sending
router.get("/bulk-progress", getBulkProgress);

export default router;
