// routes/analyticsRoutes.js

import express from "express";
import {
  getOverviewStats,
  getGroupsPerformance,
  getDashboardAnalytics,
} from "../controllers/analyticsController.js";

const router = express.Router();

// Individual endpoints
router.get("/overview", getOverviewStats);
router.get("/groups-performance", getGroupsPerformance);

// Combined endpoint (recommended for dashboard)
router.get("/dashboard", getDashboardAnalytics);

export default router;