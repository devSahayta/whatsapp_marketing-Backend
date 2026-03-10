// routes/mediaRoutes.js - NEW FILE

import express from 'express';
import { saveUploadedMedia, listMedia, deleteMedia } from '../controllers/mediaController.js';

const router = express.Router();

// POST /api/media/upload - Save uploaded media info
router.post('/upload', saveUploadedMedia);

// GET /api/media/list?account_id=xxx - List all media for account
router.get('/list', listMedia);

// DELETE /api/media/:wmu_id - Delete media record
router.delete('/:wmu_id', deleteMedia);

export default router;