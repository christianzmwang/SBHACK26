/**
 * Materials API Routes
 * 
 * Handles material management (no course dependency)
 */

import express from 'express';
import { upload, cleanupFiles } from '../middleware/upload.js';
import { 
  processAndStoreDocuments, 
  getMaterialWithChunks,
  deleteMaterial 
} from '../services/advancedDocumentProcessor.js';
import { query } from '../config/database.js';

const router = express.Router();

/**
 * Get all materials
 * GET /api/materials
 */
router.get('/materials', async (req, res) => {
  try {
    const result = await query(
      `SELECT id, type, title, file_name, total_chunks, has_math, created_at
       FROM materials 
       ORDER BY created_at DESC`
    );

    res.json({
      success: true,
      materials: result.rows
    });
  } catch (error) {
    console.error('Error fetching materials:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Upload materials
 * POST /api/materials
 */
router.post('/materials', upload.array('files', 10), async (req, res) => {
  try {
    const { type, title, chapters } = req.body;
    const files = req.files;

    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No files provided' });
    }

    // Process and store documents
    const results = await processAndStoreDocuments(files, {
      type: type || 'document',
      title: title || files[0].originalname,
      extra: {
        chapters: chapters ? JSON.parse(chapters) : null
      }
    });

    // Clean up temporary files after processing
    await cleanupFiles(files);

    res.status(201).json({
      success: true,
      results
    });
  } catch (error) {
    console.error('Error uploading materials:', error);
    // Still try to clean up files on error
    if (req.files) {
      await cleanupFiles(req.files);
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get a specific material with chunks
 * GET /api/materials/:materialId
 */
router.get('/materials/:materialId', async (req, res) => {
  try {
    const { materialId } = req.params;
    const { includeChunks } = req.query;

    let material;
    if (includeChunks === 'true') {
      material = await getMaterialWithChunks(materialId);
    } else {
      const result = await query('SELECT * FROM materials WHERE id = $1', [materialId]);
      material = result.rows[0];
    }

    if (!material) {
      return res.status(404).json({ error: 'Material not found' });
    }

    res.json({
      success: true,
      material
    });
  } catch (error) {
    console.error('Error fetching material:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Delete a material
 * DELETE /api/materials/:materialId
 */
router.delete('/materials/:materialId', async (req, res) => {
  try {
    const { materialId } = req.params;

    await deleteMaterial(materialId);

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting material:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Search materials
 * POST /api/materials/search
 */
router.post('/materials/search', async (req, res) => {
  try {
    const { query: searchQuery, chapters, topK = 10 } = req.body;

    if (!searchQuery) {
      return res.status(400).json({ error: 'Search query is required' });
    }

    const { retrieveRelevantChunks } = await import('../services/ragRetriever.js');

    const results = await retrieveRelevantChunks(searchQuery, {
      chapters,
      topK
    });

    res.json({
      success: true,
      results
    });
  } catch (error) {
    console.error('Error searching materials:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
