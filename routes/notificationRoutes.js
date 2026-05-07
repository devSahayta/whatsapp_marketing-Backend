// routes/notificationRoutes.js
import express from "express";
import * as notifCtrl from "../controllers/notificationController.js";

const router = express.Router();

// GET  /api/notifications?user_id=xxx
router.get("/notifications", notifCtrl.getNotifications);

// PATCH /api/notifications/read-all   (must be before /:id route)
router.patch("/notifications/read-all", notifCtrl.markAllAsRead);

// PATCH /api/notifications/:notification_id/read
router.patch("/notifications/:notification_id/read", notifCtrl.markAsRead);

// DELETE /api/notifications/clear  (clears all read ones)
router.delete("/notifications/clear", notifCtrl.clearReadNotifications);

export default router;
