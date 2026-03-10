// controllers/mediaController.js - NEW FILE

import { supabase } from "../config/supabase.js";

/* =====================================
   1️⃣ SAVE UPLOADED MEDIA
====================================== */

export const saveUploadedMedia = async (req, res) => {
  try {
    const {
      account_id,
      media_id,
      file_name,
      type,
      mime_type,
      size_bytes,
    } = req.body;

    if (!account_id || !media_id || !file_name) {
      return res.status(400).json({
        success: false,
        error: "account_id, media_id, and file_name are required",
      });
    }

    const { data, error } = await supabase
      .from("whatsapp_media_uploads")
      .insert({
        account_id,
        media_id,
        file_name,
        type: type || 'unknown',
        mime_type: mime_type || type || 'unknown',
        size_bytes: size_bytes || 0,
      })
      .select()
      .single();

    if (error) throw error;

    return res.status(201).json({
      success: true,
      message: "Media saved successfully",
      data: data,
    });
  } catch (err) {
    console.error("saveUploadedMedia error:", err);
    return res.status(500).json({
      success: false,
      error: "Failed to save media",
      details: err.message,
    });
  }
};

/* =====================================
   2️⃣ LIST MEDIA FOR ACCOUNT
====================================== */

export const listMedia = async (req, res) => {
  try {
    const { account_id } = req.query;

    if (!account_id) {
      return res.status(400).json({
        success: false,
        error: "account_id is required",
      });
    }

    const { data, error } = await supabase
      .from("whatsapp_media_uploads")
      .select("*")
      .eq("account_id", account_id)
      .order("uploaded_at", { ascending: false });

    if (error) throw error;

    return res.status(200).json({
      success: true,
      total: data?.length || 0,
      data: data || [],
    });
  } catch (err) {
    console.error("listMedia error:", err);
    return res.status(500).json({
      success: false,
      error: "Failed to fetch media",
      details: err.message,
    });
  }
};

/* =====================================
   3️⃣ DELETE MEDIA
====================================== */

export const deleteMedia = async (req, res) => {
  try {
    const { wmu_id } = req.params;

    if (!wmu_id) {
      return res.status(400).json({
        success: false,
        error: "wmu_id is required",
      });
    }

    const { error } = await supabase
      .from("whatsapp_media_uploads")
      .delete()
      .eq("wmu_id", wmu_id);

    if (error) throw error;

    return res.status(200).json({
      success: true,
      message: "Media deleted successfully",
    });
  } catch (err) {
    console.error("deleteMedia error:", err);
    return res.status(500).json({
      success: false,
      error: "Failed to delete media",
      details: err.message,
    });
  }
};