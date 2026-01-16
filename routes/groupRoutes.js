// import express from "express";
// import multer from "multer";
// import {
//   createEventWithCsv,
//   getEventsByUser,
//   getEventById,
//   getEventRSVPData,
//   getEventDetails,
//   getConversationStatus,
//   getEventParticipants,
// } from "../controllers/eventController.js";

// import { authenticateUser } from "../middleware/authMiddleware.js";

// import {
//   triggerBatchCall,
//   getRSVPDataByEvent,
//   retryBatchCall,
//   syncBatchStatuses,
//   getBatchStatus,
//   getDashboardData,
//   deleteEvent,
// } from "../controllers/eventController.js";

// const router = express.Router();

// // File upload config
// const upload = multer({
//   storage: multer.memoryStorage(),
//   limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
// });

// // ---------- ROUTES ----------

// // Create event + CSV upload
// router.post("/", upload.single("dataset"), createEventWithCsv);

// // Get user events
// router.get("/", getEventsByUser);

// // Get single event BY ID  (KEEP ONLY THIS)
// router.get("/:eventId", getEventById);

// // Batch operations
// router.post("/:eventId/call-batch", triggerBatchCall);
// router.post("/:eventId/retry-batch", retryBatchCall);
// router.post("/:eventId/sync-batch-status", syncBatchStatuses);
// router.get("/:eventId/batch-status", getBatchStatus);

// // RSVP data
// router.get("/:eventId/rsvps", getRSVPDataByEvent);
// router.get("/:eventId/rsvp-data", getEventRSVPData);

// //get all participant from event ID
// router.get("/:event_id/participants", getEventParticipants);

// // Event details (Protected)
// router.get("/:eventId/details", authenticateUser, getEventDetails);

// // Conversation tracking
// router.get(
//   "/:eventId/conversation-status",
//   authenticateUser,
//   getConversationStatus
// );

// // Dashboard data
// router.get("/:eventId/dashboard", getDashboardData);

// // DELETE event
// router.delete("/:eventId", deleteEvent);

// export default router;

import express from "express";
import multer from "multer";
import {
  createGroupWithCsv,
  getGroupsByUser,
  getGroupById,
  getGroupParticipants,
} from "../controllers/groupController.js";

const router = express.Router();

const upload = multer({ storage: multer.memoryStorage() });

router.post("/", upload.single("dataset"), createGroupWithCsv);
router.get("/", getGroupsByUser);
router.get("/:groupId", getGroupById);
// Get all participants in a group
router.get("/:groupId/participants", getGroupParticipants);


export default router;
