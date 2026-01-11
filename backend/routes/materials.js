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

/**
 * Get content structure (chapters/topics) for a section
 * GET /api/materials/section/:sectionId/structure
 */
router.get('/materials/section/:sectionId/structure', async (req, res) => {
  try {
    const { sectionId } = req.params;

    // Get all materials for this section
    const materialsResult = await query(
      `SELECT m.id, m.title, m.file_name, m.total_chunks, m.metadata
       FROM materials m
       JOIN section_files sf ON sf.material_id = m.id
       WHERE sf.section_id = $1
       ORDER BY m.created_at`,
      [sectionId]
    );

    if (materialsResult.rows.length === 0) {
      return res.json({
        success: true,
        structure: {
          hasChapters: false,
          materials: [],
          totalChunks: 0,
          topics: []
        }
      });
    }

    // Get all chunks with their metadata to analyze structure
    const materialIds = materialsResult.rows.map(m => m.id);
    const chunksResult = await query(
      `SELECT 
        mc.material_id,
        mc.metadata,
        mc.content_type,
        mc.embedding
       FROM material_chunks mc
       WHERE mc.material_id = ANY($1)
       ORDER BY mc.material_id, mc.chunk_index`,
      [materialIds]
    );

    // Analyze chapter structure from chunk metadata
    const chapterMap = new Map();
    let hasChapterStructure = false;
    let unstructuredCount = 0;

    for (const chunk of chunksResult.rows) {
      const chapterNum = chunk.metadata?.chapter;
      const chapterTitle = chunk.metadata?.chapterTitle;
      
      if (chapterNum && chapterTitle && chapterTitle !== 'Main Content') {
        hasChapterStructure = true;
        const key = `${chunk.material_id}_ch${chapterNum}`;
        
        if (!chapterMap.has(key)) {
          chapterMap.set(key, {
            chapterNum,
            chapterTitle,
            materialId: chunk.material_id,
            chunkCount: 0,
            topics: new Set()
          });
        }
        
        const chapter = chapterMap.get(key);
        chapter.chunkCount++;
        
        // Track topics within chapter if available
        if (chunk.metadata?.topic) {
          chapter.topics.add(chunk.metadata.topic);
        }
      } else {
        unstructuredCount++;
      }
    }

    // If more than half chunks are unstructured, don't report chapter structure
    if (unstructuredCount > chunksResult.rows.length * 0.5) {
      hasChapterStructure = false;
    }

    // Build response structure
    const materials = materialsResult.rows.map(m => ({
      id: m.id,
      title: m.title,
      fileName: m.file_name,
      totalChunks: m.total_chunks,
      structure: m.metadata?.structure || null
    }));

    let chapters = [];
    if (hasChapterStructure) {
      chapters = Array.from(chapterMap.values())
        .sort((a, b) => a.chapterNum - b.chapterNum)
        .map(ch => ({
          number: ch.chapterNum,
          title: ch.chapterTitle,
          chunkCount: ch.chunkCount,
          percentage: ((ch.chunkCount / chunksResult.rows.length) * 100).toFixed(1),
          topics: Array.from(ch.topics)
        }));
    }

    // If no chapter structure, we'll need to cluster to show topics
    // For now, just indicate clustering would be needed
    let topicSummary = null;
    if (!hasChapterStructure && chunksResult.rows.length > 0) {
      // Count chunks with embeddings for potential clustering
      const embeddedChunks = chunksResult.rows.filter(c => c.embedding).length;
      topicSummary = {
        totalChunks: chunksResult.rows.length,
        embeddedChunks,
        message: embeddedChunks > 0 
          ? `Content will be automatically grouped into ${Math.max(2, Math.ceil(embeddedChunks / 25))} natural topic clusters when generating quizzes/flashcards.`
          : 'No embeddings available for topic analysis.'
      };
    }

    res.json({
      success: true,
      structure: {
        hasChapters: hasChapterStructure,
        materials,
        totalChunks: chunksResult.rows.length,
        chapters,
        topicSummary
      }
    });
  } catch (error) {
    console.error('Error fetching content structure:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
