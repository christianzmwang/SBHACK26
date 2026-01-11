/**
 * Folders API Routes
 * 
 * Handles folder hierarchy, classes, sections, and files management
 */

import express from 'express';
import { upload, cleanupFiles } from '../middleware/upload.js';
import { query, transaction } from '../config/database.js';
import { processAndStoreDocuments, deleteMaterial } from '../services/advancedDocumentProcessor.js';
import { transcribeYouTubeVideo, isValidYouTubeUrl, getVideoInfo } from '../services/youtubeTranscriptionService.js';

const router = express.Router();

// =====================
// FOLDER OPERATIONS
// =====================

/**
 * Get all folders for a user (with full hierarchy)
 * GET /api/folders
 */
router.get('/folders', async (req, res) => {
  try {
    const userId = req.query.userId || req.headers['x-user-id'];
    
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    // Get all folders for user
    const foldersResult = await query(
      `SELECT * FROM folders WHERE user_id = $1 ORDER BY created_at ASC`,
      [userId]
    );

    // Get all sections for user's folders
    const sectionsResult = await query(
      `SELECT fs.* FROM folder_sections fs
       WHERE fs.folder_id IN (SELECT id FROM folders WHERE user_id = $1)
       ORDER BY fs.created_at ASC`,
      [userId]
    );

    // Get all files
    const filesResult = await query(
      `SELECT sf.* FROM section_files sf
       WHERE sf.section_id IN (
         SELECT fs.id FROM folder_sections fs
         WHERE fs.folder_id IN (SELECT id FROM folders WHERE user_id = $1)
       )
       ORDER BY sf.created_at ASC`,
      [userId]
    );

    // Build hierarchy
    const folders = buildFolderHierarchy(
      foldersResult.rows,
      sectionsResult.rows,
      filesResult.rows
    );

    res.json({
      success: true,
      folders
    });
  } catch (error) {
    console.error('Error fetching folders:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Create a new folder
 * POST /api/folders
 */
router.post('/folders', async (req, res) => {
  try {
    const { name, parentFolderId, userId } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Folder name is required' });
    }

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    const result = await query(
      `INSERT INTO folders (name, parent_folder_id, user_id)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [name, parentFolderId || null, userId]
    );

    res.status(201).json({
      success: true,
      folder: {
        id: result.rows[0].id,
        name: result.rows[0].name,
        classes: [],
        subfolders: [],
        sections: []
      }
    });
  } catch (error) {
    console.error('Error creating folder:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Update a folder
 * PUT /api/folders/:folderId
 */
router.put('/folders/:folderId', async (req, res) => {
  try {
    const { folderId } = req.params;
    const { name } = req.body;

    const result = await query(
      `UPDATE folders SET name = COALESCE($1, name) WHERE id = $2 RETURNING *`,
      [name, folderId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Folder not found' });
    }

    res.json({
      success: true,
      folder: result.rows[0]
    });
  } catch (error) {
    console.error('Error updating folder:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Delete a folder
 * DELETE /api/folders/:folderId
 */
router.delete('/folders/:folderId', async (req, res) => {
  try {
    const { folderId } = req.params;

    await query('DELETE FROM folders WHERE id = $1', [folderId]);

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting folder:', error);
    res.status(500).json({ error: error.message });
  }
});

// =====================
// SECTION OPERATIONS
// =====================

/**
 * Create a section in a folder
 * POST /api/folders/:folderId/sections
 */
router.post('/folders/:folderId/sections', async (req, res) => {
  try {
    const { folderId } = req.params;
    const { title, description, type } = req.body;

    if (!title) {
      return res.status(400).json({ error: 'Section title is required' });
    }

    const result = await query(
      `INSERT INTO folder_sections (folder_id, title, description, type)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [folderId, title, description || '', type || 'custom']
    );

    res.status(201).json({
      success: true,
      section: {
        id: result.rows[0].id,
        title: result.rows[0].title,
        description: result.rows[0].description,
        type: result.rows[0].type,
        files: []
      }
    });
  } catch (error) {
    console.error('Error creating section:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get a section by ID
 * GET /api/sections/:sectionId
 */
router.get('/sections/:sectionId', async (req, res) => {
  try {
    const { sectionId } = req.params;

    // Get section info
    const sectionResult = await query(
      'SELECT * FROM folder_sections WHERE id = $1',
      [sectionId]
    );

    if (sectionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Section not found' });
    }

    const section = sectionResult.rows[0];

    // Get files for this section
    const filesResult = await query(
      'SELECT * FROM section_files WHERE section_id = $1 ORDER BY created_at ASC',
      [sectionId]
    );

    const files = filesResult.rows.map(f => ({
      id: f.id,
      name: f.name,
      size: f.size,
      uploadDate: f.upload_date,
      materialId: f.material_id
    }));

    res.json({
      success: true,
      section: {
        id: section.id,
        title: section.title,
        description: section.description,
        type: section.type,
        files
      }
    });
  } catch (error) {
    console.error('Error fetching section:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Delete a section
 * DELETE /api/sections/:sectionId
 */
router.delete('/sections/:sectionId', async (req, res) => {
  try {
    const { sectionId } = req.params;

    // Delete associated files from materials if they exist
    const filesResult = await query(
      'SELECT material_id FROM section_files WHERE section_id = $1 AND material_id IS NOT NULL',
      [sectionId]
    );

    for (const file of filesResult.rows) {
      if (file.material_id) {
        try {
          await deleteMaterial(file.material_id);
        } catch (e) {
          console.warn('Failed to delete material:', e.message);
        }
      }
    }

    await query('DELETE FROM folder_sections WHERE id = $1', [sectionId]);

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting section:', error);
    res.status(500).json({ error: error.message });
  }
});

// =====================
// FILE OPERATIONS
// =====================

/**
 * Upload files to a section
 * POST /api/sections/:sectionId/files
 */
router.post('/sections/:sectionId/files', upload.array('files', 10), async (req, res) => {
  try {
    const { sectionId } = req.params;
    const files = req.files;

    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No files provided' });
    }

    // Get section info to determine type
    const sectionResult = await query('SELECT * FROM folder_sections WHERE id = $1', [sectionId]);
    if (sectionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Section not found' });
    }
    const section = sectionResult.rows[0];

    const results = [];

    const warnings = [];

    for (const file of files) {
      let materialId = null;
      let fileWarning = null;

      // Always process and store the document
      try {
        const processResults = await processAndStoreDocuments([file], {
          type: section.type || 'document',
          title: file.originalname
        });
        if (processResults[0]?.success && processResults[0]?.materialId) {
          materialId = processResults[0].materialId;
        }
        // Capture any warnings from processing
        if (processResults[0]?.warning) {
          fileWarning = processResults[0].warning;
          warnings.push({
            fileName: file.originalname,
            ...processResults[0].warning
          });
        }
      } catch (e) {
        console.error('Failed to process document:', e.message);
        console.error('Full error:', e);
        // For MP3 files, add a specific warning about Deepgram
        if (file.originalname.toLowerCase().endsWith('.mp3')) {
          warnings.push({
            fileName: file.originalname,
            type: 'processing_error',
            message: `Audio transcription failed: ${e.message}`,
            suggestion: 'Check that DEEPGRAM_API_KEY is set in your Vercel environment variables and that you have credits available.'
          });
        }
      }

      // Store file reference (text content is stored as chunks in material_chunks table)
      const fileResult = await query(
        `INSERT INTO section_files (section_id, material_id, name, size, text_content)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [sectionId, materialId, file.originalname, formatFileSize(file.size), null]
      );

      results.push({
        id: fileResult.rows[0].id,
        name: fileResult.rows[0].name,
        size: fileResult.rows[0].size,
        uploadDate: fileResult.rows[0].upload_date,
        materialId: fileResult.rows[0].material_id,
        warning: fileWarning
      });
    }

    // Clean up temporary files after processing
    await cleanupFiles(files);

    res.status(201).json({
      success: true,
      files: results,
      warnings: warnings.length > 0 ? warnings : undefined
    });
  } catch (error) {
    console.error('Error uploading files:', error);
    // Still try to clean up files on error
    if (req.files) {
      await cleanupFiles(req.files);
    }
    res.status(500).json({ error: error.message });
  }
});


/**
 * Upload a YouTube video to a section (transcribed via Deepgram)
 * POST /api/sections/:sectionId/youtube
 */
router.post('/sections/:sectionId/youtube', async (req, res) => {
  try {
    const { sectionId } = req.params;
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({ error: 'YouTube URL is required' });
    }

    if (!isValidYouTubeUrl(url)) {
      return res.status(400).json({ error: 'Invalid YouTube URL. Please provide a valid YouTube video link.' });
    }

    // Get section info
    const sectionResult = await query('SELECT * FROM folder_sections WHERE id = $1', [sectionId]);
    if (sectionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Section not found' });
    }
    const section = sectionResult.rows[0];

    console.log(`[YouTube Upload] Processing YouTube URL for section ${sectionId}: ${url}`);

    // Get video info first for the file name
    const videoInfo = await getVideoInfo(url);
    const fileName = `${videoInfo.title} (YouTube).txt`;

    // Transcribe the YouTube video
    const { transcript } = await transcribeYouTubeVideo(url, (progress) => {
      console.log(`[YouTube Upload] ${progress.message}`);
    });

    if (!transcript || transcript.trim().length === 0) {
      return res.status(400).json({ error: 'Could not transcribe the YouTube video. The video may not have audio or may be too short.' });
    }

    // Process and store the transcript as a document
    let materialId = null;
    let fileWarning = null;

    try {
      // Create a mock file object for the processor
      const mockFile = {
        originalname: fileName,
        buffer: Buffer.from(transcript, 'utf-8'),
        mimetype: 'text/plain',
        size: Buffer.byteLength(transcript, 'utf-8'),
        path: null, // No file path, using buffer
      };

      const processResults = await processAndStoreDocuments([mockFile], {
        type: section.type || 'document',
        title: videoInfo.title,
        textContent: transcript, // Pass the transcript directly
      });

      if (processResults[0]?.success && processResults[0]?.materialId) {
        materialId = processResults[0].materialId;
      }
      if (processResults[0]?.warning) {
        fileWarning = processResults[0].warning;
      }
    } catch (e) {
      console.error('[YouTube Upload] Failed to process transcript:', e.message);
      // Continue anyway - we'll store the file without material processing
    }

    // Store file reference
    const fileResult = await query(
      `INSERT INTO section_files (section_id, material_id, name, size, text_content)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [sectionId, materialId, fileName, formatFileSize(Buffer.byteLength(transcript, 'utf-8')), null]
    );

    const result = {
      id: fileResult.rows[0].id,
      name: fileResult.rows[0].name,
      size: fileResult.rows[0].size,
      uploadDate: fileResult.rows[0].upload_date,
      materialId: fileResult.rows[0].material_id,
      videoInfo: {
        title: videoInfo.title,
        author: videoInfo.author,
        duration: videoInfo.duration,
      },
      warning: fileWarning
    };

    console.log(`[YouTube Upload] Successfully processed YouTube video: ${videoInfo.title}`);

    res.status(201).json({
      success: true,
      file: result,
      warning: fileWarning
    });
  } catch (error) {
    console.error('[YouTube Upload] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get file text content from processed chunks
 * GET /api/files/:fileId/content
 */
router.get('/files/:fileId/content', async (req, res) => {
  try {
    const { fileId } = req.params;

    // Get file info
    const fileResult = await query('SELECT * FROM section_files WHERE id = $1', [fileId]);
    if (fileResult.rows.length === 0) {
      return res.status(404).json({ error: 'File not found' });
    }

    const file = fileResult.rows[0];

    // If no material_id, the file wasn't processed (legacy file or processing failed)
    if (!file.material_id) {
      return res.json({
        success: true,
        textContent: null,
        message: 'This file was not processed. It may have been uploaded before text extraction was enabled, or processing failed. Please delete and re-upload the file.'
      });
    }

    // Get chunks for this material
    const chunksResult = await query(
      `SELECT content, chunk_index FROM material_chunks 
       WHERE material_id = $1 
       ORDER BY chunk_index ASC`,
      [file.material_id]
    );

    if (chunksResult.rows.length === 0) {
      return res.json({
        success: true,
        textContent: null,
        message: 'No text content extracted from this file.'
      });
    }

    // Combine all chunks into full text
    const textContent = chunksResult.rows.map(c => c.content).join('\n\n');

    res.json({
      success: true,
      textContent,
      chunkCount: chunksResult.rows.length
    });
  } catch (error) {
    console.error('Error fetching file content:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Upload a voice transcript to a section
 * POST /api/sections/:sectionId/transcript
 */
router.post('/sections/:sectionId/transcript', async (req, res) => {
  try {
    const { sectionId } = req.params;
    const { transcript, title } = req.body;

    if (!transcript || transcript.trim().length === 0) {
      return res.status(400).json({ error: 'Transcript content is required' });
    }

    // Get section info
    const sectionResult = await query('SELECT * FROM folder_sections WHERE id = $1', [sectionId]);
    if (sectionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Section not found' });
    }
    const section = sectionResult.rows[0];

    const fileName = `${title || 'Voice Recording'} (Transcript).txt`;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const uniqueFileName = `${title || 'Voice Recording'} - ${timestamp} (Transcript).txt`;

    console.log(`[Transcript Upload] Processing transcript for section ${sectionId}: ${fileName}`);

    // Process and store the transcript as a document
    let materialId = null;
    let fileWarning = null;

    try {
      // Create a mock file object for the processor
      const mockFile = {
        originalname: uniqueFileName,
        buffer: Buffer.from(transcript, 'utf-8'),
        mimetype: 'text/plain',
        size: Buffer.byteLength(transcript, 'utf-8'),
        path: null,
      };

      const processResults = await processAndStoreDocuments([mockFile], {
        type: section.type || 'lecture_notes',
        title: title || 'Voice Recording',
        textContent: transcript,
      });

      if (processResults[0]?.success && processResults[0]?.materialId) {
        materialId = processResults[0].materialId;
      }
      if (processResults[0]?.warning) {
        fileWarning = processResults[0].warning;
      }
    } catch (e) {
      console.error('[Transcript Upload] Failed to process transcript:', e.message);
    }

    // Store file reference
    const fileResult = await query(
      `INSERT INTO section_files (section_id, material_id, name, size, text_content)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [sectionId, materialId, uniqueFileName, formatFileSize(Buffer.byteLength(transcript, 'utf-8')), null]
    );

    const result = {
      id: fileResult.rows[0].id,
      name: fileResult.rows[0].name,
      size: fileResult.rows[0].size,
      uploadDate: fileResult.rows[0].upload_date,
      materialId: fileResult.rows[0].material_id,
      warning: fileWarning
    };

    console.log(`[Transcript Upload] Successfully saved transcript: ${uniqueFileName}`);

    res.status(201).json({
      success: true,
      file: result,
      warning: fileWarning
    });
  } catch (error) {
    console.error('[Transcript Upload] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Delete a file
 * DELETE /api/files/:fileId
 */
router.delete('/files/:fileId', async (req, res) => {
  try {
    const { fileId } = req.params;

    // Get file info
    const fileResult = await query('SELECT * FROM section_files WHERE id = $1', [fileId]);
    if (fileResult.rows.length === 0) {
      return res.status(404).json({ error: 'File not found' });
    }

    const file = fileResult.rows[0];

    // Delete associated material if exists
    if (file.material_id) {
      try {
        await deleteMaterial(file.material_id);
      } catch (e) {
        console.warn('Failed to delete material:', e.message);
      }
    }

    await query('DELETE FROM section_files WHERE id = $1', [fileId]);

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting file:', error);
    res.status(500).json({ error: error.message });
  }
});

// =====================
// HELPER FUNCTIONS
// =====================

function buildFolderHierarchy(folders, sections, files) {
  // Create maps for quick lookup
  const folderMap = new Map();

  // Initialize folders
  folders.forEach(f => {
    folderMap.set(f.id, {
      id: f.id,
      name: f.name,
      parentFolderId: f.parent_folder_id,
      subfolders: [],
      sections: []
    });
  });

  // Initialize sections with files and assign to folders
  sections.forEach(s => {
    const sectionFiles = files
      .filter(f => f.section_id === s.id)
      .map(f => ({
        id: f.id,
        name: f.name,
        size: f.size,
        uploadDate: f.upload_date,
        materialId: f.material_id,
        textContent: f.text_content
      }));

    if (s.folder_id && folderMap.has(s.folder_id)) {
      folderMap.get(s.folder_id).sections.push({
        id: s.id,
        title: s.title,
        description: s.description,
        type: s.type,
        files: sectionFiles
      });
    }
  });

  // Build folder tree
  const rootFolders = [];
  folderMap.forEach(folder => {
    if (folder.parentFolderId && folderMap.has(folder.parentFolderId)) {
      folderMap.get(folder.parentFolderId).subfolders.push(folder);
    } else if (!folder.parentFolderId) {
      rootFolders.push(folder);
    }
  });

  // Clean up internal properties
  const cleanFolder = (folder) => {
    delete folder.parentFolderId;
    folder.subfolders = folder.subfolders.map(cleanFolder);
    return folder;
  };

  return rootFolders.map(cleanFolder);
}

function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// =====================
// PRACTICE GENERATION (Quiz/Flashcards from Sections)
// =====================

/**
 * Generate a quiz from sections
 * POST /api/sections/generate-quiz
 */
router.post('/sections/generate-quiz', async (req, res) => {
  try {
    const { sectionIds, userId, questionCount, questionType, difficulty, name } = req.body;

    if (!sectionIds || sectionIds.length === 0) {
      return res.status(400).json({ error: 'At least one section ID is required' });
    }

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    // Import the quiz generator function
    const { generateQuizFromSections } = await import('../services/quizGenerator.js');

    const result = await generateQuizFromSections({
      sectionIds,
      userId,
      questionCount: parseInt(questionCount) || 10,
      questionType: questionType || 'multiple_choice',
      difficulty: difficulty || 'mixed',
      name
    });

    res.status(201).json({
      success: true,
      quiz: result
    });
  } catch (error) {
    console.error('Error generating quiz from sections:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Generate flashcards from sections
 * POST /api/sections/generate-flashcards
 */
router.post('/sections/generate-flashcards', async (req, res) => {
  try {
    const { sectionIds, userId, count, topic, name } = req.body;

    if (!sectionIds || sectionIds.length === 0) {
      return res.status(400).json({ error: 'At least one section ID is required' });
    }

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    // Import the flashcard generator function
    const { generateFlashcardsFromSections } = await import('../services/quizGenerator.js');

    const result = await generateFlashcardsFromSections({
      sectionIds,
      userId,
      count: parseInt(count) || 20,
      topic,
      name
    });

    res.status(201).json({
      success: true,
      flashcardSet: result
    });
  } catch (error) {
    console.error('Error generating flashcards from sections:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get user's quizzes
 * GET /api/users/:userId/quizzes
 */
router.get('/users/:userId/quizzes', async (req, res) => {
  try {
    const { userId } = req.params;

    const { getQuizzesByUser } = await import('../services/quizGenerator.js');
    const quizzes = await getQuizzesByUser(userId);

    res.json({
      success: true,
      quizzes
    });
  } catch (error) {
    console.error('Error fetching user quizzes:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get user's flashcard sets
 * GET /api/users/:userId/flashcard-sets
 */
router.get('/users/:userId/flashcard-sets', async (req, res) => {
  try {
    const { userId } = req.params;

    const { getFlashcardSetsByUser } = await import('../services/quizGenerator.js');
    const flashcardSets = await getFlashcardSetsByUser(userId);

    res.json({
      success: true,
      flashcardSets
    });
  } catch (error) {
    console.error('Error fetching user flashcard sets:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get a specific quiz with questions
 * GET /api/quiz/:quizId
 */
router.get('/quiz/:quizId', async (req, res) => {
  try {
    const { quizId } = req.params;

    const { getQuiz } = await import('../services/quizGenerator.js');
    const quiz = await getQuiz(quizId);

    if (!quiz) {
      return res.status(404).json({ error: 'Quiz not found' });
    }

    res.json({
      success: true,
      quiz
    });
  } catch (error) {
    console.error('Error fetching quiz:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Delete a quiz
 * DELETE /api/quiz/:quizId
 */
router.delete('/quiz/:quizId', async (req, res) => {
  try {
    const { quizId } = req.params;

    const { deleteQuiz } = await import('../services/quizGenerator.js');
    await deleteQuiz(quizId);

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting quiz:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Submit quiz answers and get score
 * POST /api/quiz/:quizId/submit
 */
router.post('/quiz/:quizId/submit', async (req, res) => {
  try {
    const { quizId } = req.params;
    const { answers } = req.body; // { questionId: answer }

    if (!answers || typeof answers !== 'object') {
      return res.status(400).json({ error: 'Answers are required' });
    }

    // Get quiz with questions
    const { getQuiz } = await import('../services/quizGenerator.js');
    const quiz = await getQuiz(quizId);

    if (!quiz) {
      return res.status(404).json({ error: 'Quiz not found' });
    }

    // Score the quiz
    let correct = 0;
    const total = quiz.questions.length;
    const results = [];

    for (const question of quiz.questions) {
      const userAnswer = answers[question.id];
      const isCorrect = userAnswer === question.correct_answer;

      if (isCorrect) correct++;

      results.push({
        questionId: question.id,
        question: question.question,
        userAnswer,
        correctAnswer: question.correct_answer,
        isCorrect,
        explanation: question.explanation
      });
    }

    res.json({
      success: true,
      score: {
        correct,
        total,
        percentage: Math.round((correct / total) * 100)
      },
      results
    });
  } catch (error) {
    console.error('Error submitting quiz:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get a specific flashcard set
 * GET /api/flashcards/:setId
 */
router.get('/flashcards/:setId', async (req, res) => {
  try {
    const { setId } = req.params;

    const { getFlashcardSet } = await import('../services/quizGenerator.js');
    const flashcardSet = await getFlashcardSet(setId);

    if (!flashcardSet) {
      return res.status(404).json({ error: 'Flashcard set not found' });
    }

    res.json({
      success: true,
      flashcardSet
    });
  } catch (error) {
    console.error('Error fetching flashcard set:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Delete flashcard set
 * DELETE /api/flashcards/:setId
 */
router.delete('/flashcards/:setId', async (req, res) => {
  try {
    const { setId } = req.params;

    const { deleteFlashcardSet } = await import('../services/quizGenerator.js');
    await deleteFlashcardSet(setId);

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting flashcard set:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
