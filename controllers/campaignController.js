// controllers/campaignController.js

import { supabase } from "../config/supabase.js";

/* =====================================
   1️⃣ CREATE CAMPAIGN
====================================== */

export const createCampaign = async (req, res) => {
  try {
    const {
      user_id,
      campaign_name,
      description,
      group_id,
      wt_id,
      account_id,
      scheduled_at,
      timezone,
      template_variables,
    } = req.body;

    // Validate required fields
    if (!user_id || !campaign_name || !group_id || !wt_id || !account_id || !scheduled_at) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: user_id, campaign_name, group_id, wt_id, account_id, scheduled_at",
      });
    }

    // Check if scheduled_at is in the future
    const scheduledDate = new Date(scheduled_at);
    const now = new Date();
    
    if (scheduledDate <= now) {
      return res.status(400).json({
        success: false,
        error: "Scheduled time must be in the future",
      });
    }

    // Get total recipients count
    const { data: contacts, error: contactsError } = await supabase
      .from("group_contacts")
      .select("contact_id, phone_number, full_name")
      .eq("group_id", group_id)
      .eq("user_id", user_id);

    if (contactsError) throw contactsError;

    const totalRecipients = contacts?.length || 0;

    if (totalRecipients === 0) {
      return res.status(400).json({
        success: false,
        error: "No contacts found in this group",
      });
    }

    // Create campaign
    const { data: campaign, error: campaignError } = await supabase
      .from("campaigns")
      .insert({
        user_id,
        campaign_name,
        description,
        group_id,
        wt_id,
        account_id,
        scheduled_at,
        timezone: timezone || "UTC",
        template_variables: template_variables || {},
        status: "scheduled",
        total_recipients: totalRecipients,
      })
      .select()
      .single();

    if (campaignError) throw campaignError;

    // Create campaign_messages entries for each contact (pending status)
    const campaignMessages = contacts.map((contact) => ({
      campaign_id: campaign.campaign_id,
      contact_id: contact.contact_id,
      phone_number: contact.phone_number,
      contact_name: contact.full_name,
      status: "pending",
    }));

    const { error: messagesError } = await supabase
      .from("campaign_messages")
      .insert(campaignMessages);

    if (messagesError) throw messagesError;

    return res.status(201).json({
      success: true,
      message: "Campaign created successfully",
      data: campaign,
    });
  } catch (err) {
    console.error("createCampaign error:", err);
    return res.status(500).json({
      success: false,
      error: "Failed to create campaign",
      details: err.message,
    });
  }
};

/* =====================================
   2️⃣ GET ALL CAMPAIGNS (for a user)
====================================== */

export const getCampaigns = async (req, res) => {
  try {
    const { user_id } = req.query;

    if (!user_id) {
      return res.status(400).json({
        success: false,
        error: "user_id is required",
      });
    }

    // Get campaigns with relations using foreign keys
    const { data: campaigns, error } = await supabase
      .from("campaigns")
      .select(`
        *,
        groups!fk_campaigns_group_id (
          group_name,
          description
        ),
        whatsapp_templates!fk_campaigns_wt_id (
          name,
          category,
          language,
          status,
          template_id
        ),
        whatsapp_accounts!fk_campaigns_account_id (
          business_phone_number
        )
      `)
      .eq("user_id", user_id)
      .order("created_at", { ascending: false });

    if (error) throw error;

    return res.status(200).json({
      success: true,
      total: campaigns?.length || 0,
      data: campaigns || [],
    });
  } catch (err) {
    console.error("getCampaigns error:", err);
    return res.status(500).json({
      success: false,
      error: "Failed to fetch campaigns",
      details: err.message,
    });
  }
};

/* =====================================
   3️⃣ GET SINGLE CAMPAIGN (with details)
====================================== */

export const getCampaignById = async (req, res) => {
  try {
    const { campaign_id } = req.params;
    const { user_id } = req.query;

    if (!user_id) {
      return res.status(400).json({
        success: false,
        error: "user_id is required",
      });
    }

    // Get campaign details with relations
    const { data: campaign, error: campaignError } = await supabase
      .from("campaigns")
      .select(`
        *,
        groups!fk_campaigns_group_id (
          group_name,
          description,
          status
        ),
        whatsapp_templates!fk_campaigns_wt_id (
          name,
          category,
          language,
          components,
          preview,
          template_id
        ),
        whatsapp_accounts!fk_campaigns_account_id (
          business_phone_number
        )
      `)
      .eq("campaign_id", campaign_id)
      .eq("user_id", user_id)
      .single();

    if (campaignError) throw campaignError;

    if (!campaign) {
      return res.status(404).json({
        success: false,
        error: "Campaign not found",
      });
    }

    // Get campaign messages
    const { data: messages, error: messagesError } = await supabase
      .from("campaign_messages")
      .select("*")
      .eq("campaign_id", campaign_id)
      .order("created_at", { ascending: false });

    if (messagesError) throw messagesError;

    // Calculate statistics
    const stats = {
      total: messages?.length || 0,
      pending: messages?.filter((m) => m.status === "pending").length || 0,
      sent: messages?.filter((m) => m.status === "sent").length || 0,
      delivered: messages?.filter((m) => m.status === "delivered").length || 0,
      read: messages?.filter((m) => m.status === "read").length || 0,
      failed: messages?.filter((m) => m.status === "failed").length || 0,
    };

    return res.status(200).json({
      success: true,
      data: {
        campaign,
        messages: messages || [],
        stats,
      },
    });
  } catch (err) {
    console.error("getCampaignById error:", err);
    return res.status(500).json({
      success: false,
      error: "Failed to fetch campaign details",
      details: err.message,
    });
  }
};

/* =====================================
   4️⃣ UPDATE CAMPAIGN (reschedule)
====================================== */

export const updateCampaign = async (req, res) => {
  try {
    const { campaign_id } = req.params;
    const { user_id, scheduled_at, campaign_name, description } = req.body;

    if (!user_id) {
      return res.status(400).json({
        success: false,
        error: "user_id is required",
      });
    }

    // Check if campaign exists and belongs to user
    const { data: existing, error: existError } = await supabase
      .from("campaigns")
      .select("campaign_id, status")
      .eq("campaign_id", campaign_id)
      .eq("user_id", user_id)
      .single();

    if (existError || !existing) {
      return res.status(404).json({
        success: false,
        error: "Campaign not found",
      });
    }

    // Can only update scheduled campaigns
    if (existing.status !== "scheduled") {
      return res.status(400).json({
        success: false,
        error: `Cannot update campaign with status: ${existing.status}`,
      });
    }

    // Validate new scheduled_at if provided
    if (scheduled_at) {
      const scheduledDate = new Date(scheduled_at);
      const now = new Date();

      if (scheduledDate <= now) {
        return res.status(400).json({
          success: false,
          error: "Scheduled time must be in the future",
        });
      }
    }

    // Update campaign
    const updateData = {};
    if (scheduled_at) updateData.scheduled_at = scheduled_at;
    if (campaign_name) updateData.campaign_name = campaign_name;
    if (description !== undefined) updateData.description = description;

    const { data: updated, error: updateError } = await supabase
      .from("campaigns")
      .update(updateData)
      .eq("campaign_id", campaign_id)
      .eq("user_id", user_id)
      .select()
      .single();

    if (updateError) throw updateError;

    return res.status(200).json({
      success: true,
      message: "Campaign updated successfully",
      data: updated,
    });
  } catch (err) {
    console.error("updateCampaign error:", err);
    return res.status(500).json({
      success: false,
      error: "Failed to update campaign",
      details: err.message,
    });
  }
};

/* =====================================
   5️⃣ CANCEL CAMPAIGN
====================================== */

export const cancelCampaign = async (req, res) => {
  try {
    const { campaign_id } = req.params;
    const { user_id } = req.body;

    if (!user_id) {
      return res.status(400).json({
        success: false,
        error: "user_id is required",
      });
    }

    // Check if campaign exists and belongs to user
    const { data: existing, error: existError } = await supabase
      .from("campaigns")
      .select("campaign_id, status")
      .eq("campaign_id", campaign_id)
      .eq("user_id", user_id)
      .single();

    if (existError || !existing) {
      return res.status(404).json({
        success: false,
        error: "Campaign not found",
      });
    }

    // Can only cancel scheduled or processing campaigns
    if (!["scheduled", "processing"].includes(existing.status)) {
      return res.status(400).json({
        success: false,
        error: `Cannot cancel campaign with status: ${existing.status}`,
      });
    }

    // Update campaign status to cancelled
    const { data: cancelled, error: cancelError } = await supabase
      .from("campaigns")
      .update({ status: "cancelled" })
      .eq("campaign_id", campaign_id)
      .eq("user_id", user_id)
      .select()
      .single();

    if (cancelError) throw cancelError;

    return res.status(200).json({
      success: true,
      message: "Campaign cancelled successfully",
      data: cancelled,
    });
  } catch (err) {
    console.error("cancelCampaign error:", err);
    return res.status(500).json({
      success: false,
      error: "Failed to cancel campaign",
      details: err.message,
    });
  }
};

/* =====================================
   6️⃣ DELETE CAMPAIGN
====================================== */

export const deleteCampaign = async (req, res) => {
  try {
    const { campaign_id } = req.params;
    const { user_id } = req.query;

    if (!user_id) {
      return res.status(400).json({
        success: false,
        error: "user_id is required",
      });
    }

    // Check if campaign exists and belongs to user
    const { data: existing, error: existError } = await supabase
      .from("campaigns")
      .select("campaign_id, status")
      .eq("campaign_id", campaign_id)
      .eq("user_id", user_id)
      .single();

    if (existError || !existing) {
      return res.status(404).json({
        success: false,
        error: "Campaign not found",
      });
    }

    // Can only delete scheduled or cancelled campaigns
    if (!["scheduled", "cancelled", "completed", "failed"].includes(existing.status)) {
      return res.status(400).json({
        success: false,
        error: `Cannot delete campaign with status: ${existing.status}`,
      });
    }

    // Delete campaign (cascade will delete campaign_messages)
    const { error: deleteError } = await supabase
      .from("campaigns")
      .delete()
      .eq("campaign_id", campaign_id)
      .eq("user_id", user_id);

    if (deleteError) throw deleteError;

    return res.status(200).json({
      success: true,
      message: "Campaign deleted successfully",
    });
  } catch (err) {
    console.error("deleteCampaign error:", err);
    return res.status(500).json({
      success: false,
      error: "Failed to delete campaign",
      details: err.message,
    });
  }
};

/* =====================================
   7️⃣ GET USER'S GROUPS (for dropdown)
====================================== */

export const getUserGroups = async (req, res) => {
  try {
    const { user_id } = req.query;

    if (!user_id) {
      return res.status(400).json({
        success: false,
        error: "user_id is required",
      });
    }

    const { data: groups, error } = await supabase
      .from("groups")
      .select(`
        group_id,
        group_name,
        description,
        status,
        created_at
      `)
      .eq("user_id", user_id)
      .eq("status", "active")
      .order("created_at", { ascending: false });

    if (error) throw error;

    // Get contact count for each group
    const groupsWithCounts = await Promise.all(
      (groups || []).map(async (group) => {
        const { data: contacts } = await supabase
          .from("group_contacts")
          .select("contact_id")
          .eq("group_id", group.group_id);

        return {
          ...group,
          contact_count: contacts?.length || 0,
        };
      })
    );

    return res.status(200).json({
      success: true,
      total: groupsWithCounts.length,
      data: groupsWithCounts,
    });
  } catch (err) {
    console.error("getUserGroups error:", err);
    return res.status(500).json({
      success: false,
      error: "Failed to fetch groups",
      details: err.message,
    });
  }
};

/* =====================================
   8️⃣ GET USER'S TEMPLATES (for dropdown)
====================================== */

export const getUserTemplates = async (req, res) => {
  try {
    const { user_id } = req.query;

    if (!user_id) {
      return res.status(400).json({
        success: false,
        error: "user_id is required",
      });
    }

    // Get user's WhatsApp accounts
    const { data: accounts } = await supabase
      .from("whatsapp_accounts")
      .select("wa_id")
      .eq("user_id", user_id);

    if (!accounts || accounts.length === 0) {
      return res.status(200).json({
        success: true,
        total: 0,
        data: [],
      });
    }

    const accountIds = accounts.map((a) => a.wa_id);

    // Get templates for these accounts
    const { data: templates, error } = await supabase
      .from("whatsapp_templates")
      .select(`
        wt_id,
        account_id,
        template_id,
        name,
        language,
        category,
        components,
        header_format,
        variables,
        buttons,
        preview,
        status
      `)
      .in("account_id", accountIds)
      .eq("status", "APPROVED")
      .order("created_at", { ascending: false });

    if (error) throw error;

    return res.status(200).json({
      success: true,
      total: templates?.length || 0,
      data: templates || [],
    });
  } catch (err) {
    console.error("getUserTemplates error:", err);
    return res.status(500).json({
      success: false,
      error: "Failed to fetch templates",
      details: err.message,
    });
  }
};