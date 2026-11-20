// routes/customPricingRoutes.js
import express from "express";
import { submitCustomPricingRequest } from "../controllers/customPricingController.js";

const router = express.Router();

router.post("/contact", submitCustomPricingRequest);

export default router;
