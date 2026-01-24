// routes/analyticsRoutes.js
import express from "express";
import { getMessageStatsAndChart } from "../controllers/analyticsController.js";

const router = express.Router();

router.get("/message-stats", getMessageStatsAndChart);

export default router;
