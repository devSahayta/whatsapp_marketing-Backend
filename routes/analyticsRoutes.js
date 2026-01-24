// routes/analyticsRoutes.js

import express from "express";
import { getMessageStatsAndChart } from "../controllers/analyticsController.js";
import {
  getOverviewStats,
  getGroupsPerformance,
  getDashboardAnalytics,
} from "../controllers/analyticsController.js";

const router = express.Router();

//get template message
router.get("/message-stats", getMessageStatsAndChart);

// Individual endpoints
router.get("/overview", getOverviewStats);
router.get("/groups-performance", getGroupsPerformance);

// Combined endpoint (recommended for dashboard)
router.get("/dashboard", getDashboardAnalytics);

export default router;
