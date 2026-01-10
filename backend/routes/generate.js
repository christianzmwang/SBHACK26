import express from 'express';
import multer from 'multer';
import { upload } from '../middleware/upload.js';
import { generateController } from '../controllers/generateController.js';

const router = express.Router();

router.post('/generate', upload.array('documents'), generateController);

export default router;
