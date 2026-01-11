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
 * 
 * Returns structure PER MATERIAL so each file's chapters/topics are shown individually
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
          materials: [],
          totalChunks: 0
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

    // Group chunks by material
    const chunksByMaterial = new Map();
    for (const chunk of chunksResult.rows) {
      if (!chunksByMaterial.has(chunk.material_id)) {
        chunksByMaterial.set(chunk.material_id, []);
      }
      chunksByMaterial.get(chunk.material_id).push(chunk);
    }

    // Analyze structure for each material individually
    const materials = materialsResult.rows.map(m => {
      const materialChunks = chunksByMaterial.get(m.id) || [];
      
      // Analyze chapter structure for this specific material
      const chapterMap = new Map();
      let structuredCount = 0;
      let unstructuredCount = 0;

      for (const chunk of materialChunks) {
        const chapterNum = chunk.metadata?.chapter;
        const chapterTitle = chunk.metadata?.chapterTitle;
        
        if (chapterNum && chapterTitle && chapterTitle !== 'Main Content') {
          structuredCount++;
          const key = `ch${chapterNum}`;
          
          if (!chapterMap.has(key)) {
            chapterMap.set(key, {
              chapterNum,
              chapterTitle,
              chunkCount: 0,
              topics: new Set()
            });
          }
          
          const chapter = chapterMap.get(key);
          chapter.chunkCount++;
          
          if (chunk.metadata?.topic) {
            chapter.topics.add(chunk.metadata.topic);
          }
        } else {
          unstructuredCount++;
        }
      }

      // Determine if this material has chapter structure
      // Need at least 30% of chunks to have chapter info
      const hasChapters = structuredCount > materialChunks.length * 0.3 && chapterMap.size > 0;

      let chapters = [];
      if (hasChapters) {
        chapters = Array.from(chapterMap.values())
          .sort((a, b) => a.chapterNum - b.chapterNum)
          .map(ch => ({
            number: ch.chapterNum,
            title: ch.chapterTitle,
            chunkCount: ch.chunkCount,
            percentage: ((ch.chunkCount / materialChunks.length) * 100).toFixed(1),
            topics: Array.from(ch.topics)
          }));
      }

      // Topic summary for materials without chapter structure
      let topicSummary = null;
      if (!hasChapters && materialChunks.length > 0) {
        const embeddedChunks = materialChunks.filter(c => c.embedding).length;
        const estimatedClusters = Math.max(2, Math.ceil(embeddedChunks / 25));
        
        // Collect any topics found in chunks even if chapter structure wasn't sufficient
        const foundTopics = new Set();
        
        // Topic extraction patterns (mirrors advancedDocumentProcessor.js)
        const topicPatterns = [
          /^(?:Section\s+)?(\d+\.\d+(?:\.\d+)?)\s*[:.]\s*(.+?)$/gim, // 1.2 Title
          /^(#{3,4})\s+(.+?)$/gim, // ### Subsection
          /^\*\*([^*]+)\*\*$/gim, // **Topic**
          /^[A-Z][a-zA-Z0-9\s-]{3,50}:$/gm // "Topic Name:"
        ];

        materialChunks.forEach(chunk => {
          // 1. Check metadata first
          if (chunk.metadata?.topic) {
            foundTopics.add(chunk.metadata.topic);
          }
          
          // 2. Fallback: Scan chunk content for topic headers
          // This helps for existing files where metadata might not have been captured
          if (chunk.content) {
            // Check the first few lines of the chunk for headers
            const lines = chunk.content.split('\n').slice(0, 3);
            for (const line of lines) {
              const trimmedLine = line.trim();
              if (!trimmedLine) continue;

              for (const pattern of topicPatterns) {
                pattern.lastIndex = 0;
                const match = pattern.exec(trimmedLine);
                if (match) {
                  const topicTitle = match[2]?.trim() || match[1]?.trim();
                  // Clean up title (remove trailing colons, etc)
                  const cleanTitle = topicTitle?.replace(/[:.]$/, '');
                  if (cleanTitle && cleanTitle.length > 2 && cleanTitle.length < 100) {
                    foundTopics.add(cleanTitle);
                  }
                }
              }
            }
          }
        });

        topicSummary = {
          totalChunks: materialChunks.length,
          embeddedChunks,
          estimatedClusters,
          topics: Array.from(foundTopics).sort(),
          message: embeddedChunks > 0 
            ? `Will be grouped into ~${estimatedClusters} natural topic clusters.`
            : 'No embeddings available.'
        };
      }

      return {
        id: m.id,
        title: m.title,
        fileName: m.file_name,
        totalChunks: m.total_chunks || materialChunks.length,
        hasChapters,
        chapters,
        topicSummary
      };
    });

    // Overall stats
    const totalChunks = chunksResult.rows.length;
    const materialsWithChapters = materials.filter(m => m.hasChapters).length;

    res.json({
      success: true,
      structure: {
        materials,
        totalChunks,
        materialsWithChapters,
        totalMaterials: materials.length
      }
    });
  } catch (error) {
    console.error('Error fetching content structure:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
