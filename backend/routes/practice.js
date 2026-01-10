/**
 * Practice API Routes
 * 
 * Handles practice folders, quizzes, and flashcard management
 */

import express from 'express';
import { query, transaction } from '../config/database.js';
import {
  generateQuizFromSections,
  generateFlashcardsFromSections,
  getQuiz,
  getFlashcardSet,
  getQuizzesByUser,
  getFlashcardSetsByUser,
  deleteQuiz,
  deleteFlashcardSet
} from '../services/quizGenerator.js';

const router = express.Router();

// =====================
// PRACTICE FOLDERS
// =====================

/**
 * Get all practice folders for a user
 * GET /api/practice/folders
 */
router.get('/folders', async (req, res) => {
  try {
    const userId = req.query.userId || req.headers['x-user-id'];
    
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    // Get all practice folders for user
    const foldersResult = await query(
      `SELECT * FROM practice_folders WHERE user_id = $1 ORDER BY created_at ASC`,
      [userId]
    );

    // Build hierarchy
    const folders = buildPracticeFolderHierarchy(foldersResult.rows);

    res.json({
      success: true,
      folders
    });
  } catch (error) {
    console.error('Error fetching practice folders:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Create a new practice folder
 * POST /api/practice/folders
 */
router.post('/folders', async (req, res) => {
  try {
    const { name, description, parentFolderId, userId, color, icon } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Folder name is required' });
    }

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    const result = await query(
      `INSERT INTO practice_folders (name, description, parent_folder_id, user_id, color, icon)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [name, description || null, parentFolderId || null, userId, color || 'indigo', icon || 'folder']
    );

    res.status(201).json({
      success: true,
      folder: {
        id: result.rows[0].id,
        name: result.rows[0].name,
        description: result.rows[0].description,
        color: result.rows[0].color,
        icon: result.rows[0].icon,
        subfolders: [],
        quizzes: [],
        flashcardSets: []
      }
    });
  } catch (error) {
    console.error('Error creating practice folder:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Update a practice folder
 * PUT /api/practice/folders/:folderId
 */
router.put('/folders/:folderId', async (req, res) => {
  try {
    const { folderId } = req.params;
    const { name, description, color, icon } = req.body;

    const result = await query(
      `UPDATE practice_folders 
       SET name = COALESCE($1, name),
           description = COALESCE($2, description),
           color = COALESCE($3, color),
           icon = COALESCE($4, icon)
       WHERE id = $5 
       RETURNING *`,
      [name, description, color, icon, folderId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Folder not found' });
    }

    res.json({
      success: true,
      folder: result.rows[0]
    });
  } catch (error) {
    console.error('Error updating practice folder:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Delete a practice folder
 * DELETE /api/practice/folders/:folderId
 */
router.delete('/folders/:folderId', async (req, res) => {
  try {
    const { folderId } = req.params;

    // This will cascade delete quizzes and flashcard sets in the folder
    await query('DELETE FROM practice_folders WHERE id = $1', [folderId]);

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting practice folder:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get folder with contents (quizzes and flashcard sets)
 * GET /api/practice/folders/:folderId
 */
router.get('/folders/:folderId', async (req, res) => {
  try {
    const { folderId } = req.params;

    // Get folder
    const folderResult = await query(
      'SELECT * FROM practice_folders WHERE id = $1',
      [folderId]
    );

    if (folderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Folder not found' });
    }

    // Get quizzes in folder
    const quizzesResult = await query(
      `SELECT id, name, description, total_questions, difficulty, best_score, 
              attempt_count, last_attempted_at, created_at
       FROM quiz_sets 
       WHERE folder_id = $1 
       ORDER BY created_at DESC`,
      [folderId]
    );

    // Get flashcard sets in folder
    const flashcardsResult = await query(
      `SELECT id, name, description, total_cards, mastery_count, 
              last_studied_at, created_at
       FROM flashcard_sets 
       WHERE folder_id = $1 
       ORDER BY created_at DESC`,
      [folderId]
    );

    res.json({
      success: true,
      folder: {
        ...folderResult.rows[0],
        quizzes: quizzesResult.rows,
        flashcardSets: flashcardsResult.rows
      }
    });
  } catch (error) {
    console.error('Error fetching practice folder:', error);
    res.status(500).json({ error: error.message });
  }
});

// =====================
// PRACTICE OVERVIEW
// =====================

/**
 * Get all practice content for a user (quizzes, flashcards, organized by folders)
 * GET /api/practice/overview
 */
router.get('/overview', async (req, res) => {
  try {
    const userId = req.query.userId || req.headers['x-user-id'];
    
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    // Get all practice folders
    const foldersResult = await query(
      `SELECT * FROM practice_folders WHERE user_id = $1 ORDER BY created_at ASC`,
      [userId]
    );

    // Get all quizzes with folder info
    const quizzesResult = await query(
      `SELECT id, name, description, total_questions, difficulty, best_score, 
              attempt_count, last_attempted_at, folder_id, created_at
       FROM quiz_sets 
       WHERE user_id = $1 
       ORDER BY created_at DESC`,
      [userId]
    );

    // Get all flashcard sets with folder info
    const flashcardsResult = await query(
      `SELECT id, name, description, total_cards, mastery_count, 
              last_studied_at, folder_id, created_at
       FROM flashcard_sets 
       WHERE user_id = $1 
       ORDER BY created_at DESC`,
      [userId]
    );

    // Get recent attempts
    const attemptsResult = await query(
      `SELECT qa.*, qs.name as quiz_name
       FROM quiz_attempts qa
       JOIN quiz_sets qs ON qa.quiz_set_id = qs.id
       WHERE qa.user_id = $1
       ORDER BY qa.completed_at DESC
       LIMIT 10`,
      [userId]
    );

    // Get recent flashcard sessions
    const sessionsResult = await query(
      `SELECT fs.*, fss.name as flashcard_set_name
       FROM flashcard_sessions fs
       JOIN flashcard_sets fss ON fs.flashcard_set_id = fss.id
       WHERE fs.user_id = $1
       ORDER BY fs.completed_at DESC
       LIMIT 10`,
      [userId]
    );

    // Calculate stats
    const totalQuizzes = quizzesResult.rows.length;
    const totalFlashcardSets = flashcardsResult.rows.length;
    const totalQuestions = quizzesResult.rows.reduce((sum, q) => sum + (q.total_questions || 0), 0);
    const totalCards = flashcardsResult.rows.reduce((sum, f) => sum + (f.total_cards || 0), 0);

    res.json({
      success: true,
      folders: buildPracticeFolderHierarchy(foldersResult.rows),
      quizzes: quizzesResult.rows,
      flashcardSets: flashcardsResult.rows,
      recentAttempts: attemptsResult.rows,
      recentSessions: sessionsResult.rows,
      stats: {
        totalQuizzes,
        totalFlashcardSets,
        totalQuestions,
        totalCards
      }
    });
  } catch (error) {
    console.error('Error fetching practice overview:', error);
    res.status(500).json({ error: error.message });
  }
});

// =====================
// STATS & STUDY PLAN
// =====================

/**
 * Get topic-level statistics for a user
 * GET /api/practice/stats
 */
router.get('/stats', async (req, res) => {
  try {
    const userId = req.query.userId || req.headers['x-user-id'];
    const folderId = req.query.folderId;
    
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    // Get quiz attempts with topics for the user
    // We'll aggregate scores by topic from quiz questions
    let topicStats = [];
    
    // Get all quiz attempts for this user
    const attemptsQuery = folderId
      ? `SELECT qa.*, qs.name as quiz_name, qs.folder_id
         FROM quiz_attempts qa
         JOIN quiz_sets qs ON qa.quiz_set_id = qs.id
         WHERE qa.user_id = $1 AND qs.folder_id = $2
         ORDER BY qa.completed_at DESC`
      : `SELECT qa.*, qs.name as quiz_name, qs.folder_id
         FROM quiz_attempts qa
         JOIN quiz_sets qs ON qa.quiz_set_id = qs.id
         WHERE qa.user_id = $1
         ORDER BY qa.completed_at DESC`;
    
    const attempts = await query(
      attemptsQuery,
      folderId ? [userId, folderId] : [userId]
    );

    // Get all questions from quizzes the user has attempted
    const quizIds = [...new Set(attempts.rows.map(a => a.quiz_set_id))];
    
    if (quizIds.length > 0) {
      // Get questions with their topics
      const questionsResult = await query(
        `SELECT qq.*, qs.id as quiz_set_id
         FROM quiz_questions qq
         JOIN quiz_sets qs ON qq.quiz_set_id = qs.id
         WHERE qs.id = ANY($1)`,
        [quizIds]
      );

      // Build topic stats from attempts
      const topicMap = new Map();
      
      for (const attempt of attempts.rows) {
        const answers = typeof attempt.answers === 'string' 
          ? JSON.parse(attempt.answers) 
          : attempt.answers;
        
        if (!answers) continue;
        
        // Get questions for this quiz
        const quizQuestions = questionsResult.rows.filter(q => q.quiz_set_id === attempt.quiz_set_id);
        
        for (const question of quizQuestions) {
          const topic = question.topic || 'General';
          const answerData = answers[question.id];
          
          if (!topicMap.has(topic)) {
            topicMap.set(topic, {
              name: topic,
              totalQuestions: 0,
              correctAnswers: 0,
              lastPracticed: null
            });
          }
          
          const topicData = topicMap.get(topic);
          topicData.totalQuestions++;
          
          if (answerData?.isCorrect) {
            topicData.correctAnswers++;
          }
          
          // Update last practiced
          if (!topicData.lastPracticed || new Date(attempt.completed_at) > new Date(topicData.lastPracticed)) {
            topicData.lastPracticed = attempt.completed_at;
          }
        }
      }

      // Convert to array and calculate scores
      topicStats = Array.from(topicMap.values()).map(topic => ({
        id: topic.name.toLowerCase().replace(/\s+/g, '-'),
        name: topic.name,
        score: topic.totalQuestions > 0 
          ? Math.round((topic.correctAnswers / topic.totalQuestions) * 100)
          : 0,
        totalQuestions: topic.totalQuestions,
        correctAnswers: topic.correctAnswers,
        lastPracticed: formatLastPracticed(topic.lastPracticed)
      }));
    }

    res.json({
      success: true,
      topics: topicStats
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Generate a personalized study plan based on weak topics
 * GET /api/practice/study-plan
 */
router.get('/study-plan', async (req, res) => {
  try {
    const userId = req.query.userId || req.headers['x-user-id'];
    const folderId = req.query.folderId;
    
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    // First get the user's stats to identify weak areas
    // Reuse the stats logic
    const attemptsQuery = folderId
      ? `SELECT qa.*, qs.name as quiz_name, qs.folder_id
         FROM quiz_attempts qa
         JOIN quiz_sets qs ON qa.quiz_set_id = qs.id
         WHERE qa.user_id = $1 AND qs.folder_id = $2
         ORDER BY qa.completed_at DESC`
      : `SELECT qa.*, qs.name as quiz_name, qs.folder_id
         FROM quiz_attempts qa
         JOIN quiz_sets qs ON qa.quiz_set_id = qs.id
         WHERE qa.user_id = $1
         ORDER BY qa.completed_at DESC`;
    
    const attempts = await query(
      attemptsQuery,
      folderId ? [userId, folderId] : [userId]
    );

    const quizIds = [...new Set(attempts.rows.map(a => a.quiz_set_id))];
    const topicMap = new Map();
    
    if (quizIds.length > 0) {
      const questionsResult = await query(
        `SELECT qq.*, qs.id as quiz_set_id
         FROM quiz_questions qq
         JOIN quiz_sets qs ON qq.quiz_set_id = qs.id
         WHERE qs.id = ANY($1)`,
        [quizIds]
      );

      for (const attempt of attempts.rows) {
        const answers = typeof attempt.answers === 'string' 
          ? JSON.parse(attempt.answers) 
          : attempt.answers;
        
        if (!answers) continue;
        
        const quizQuestions = questionsResult.rows.filter(q => q.quiz_set_id === attempt.quiz_set_id);
        
        for (const question of quizQuestions) {
          const topic = question.topic || 'General';
          const answerData = answers[question.id];
          
          if (!topicMap.has(topic)) {
            topicMap.set(topic, { total: 0, correct: 0 });
          }
          
          topicMap.get(topic).total++;
          if (answerData?.isCorrect) {
            topicMap.get(topic).correct++;
          }
        }
      }
    }

    // Generate study tasks based on weak topics
    const tasks = [];
    let taskId = 1;
    
    // Sort topics by score (weakest first)
    const topicScores = Array.from(topicMap.entries())
      .map(([name, data]) => ({
        name,
        score: data.total > 0 ? (data.correct / data.total) * 100 : 0,
        total: data.total,
        correct: data.correct
      }))
      .sort((a, b) => a.score - b.score);

    for (const topic of topicScores) {
      // Determine priority based on score
      let priority;
      if (topic.score < 40) priority = 'high';
      else if (topic.score < 70) priority = 'medium';
      else priority = 'low';

      // Add flashcard review for weak topics
      if (topic.score < 70) {
        const cardCount = topic.score < 40 ? 20 : 15;
        tasks.push({
          id: `task-${taskId++}`,
          type: 'flashcards',
          topic: topic.name,
          title: `Review ${topic.name} by Flashcards`,
          description: `Strengthen your understanding of ${topic.name} concepts`,
          estimatedTime: `${Math.round(cardCount * 1.5)} mins`,
          estimatedMinutes: Math.round(cardCount * 1.5),
          cardCount,
          priority,
          completed: false
        });
      }

      // Add quiz for practice
      if (topic.score < 80) {
        const questionCount = topic.score < 50 ? 10 : 5;
        tasks.push({
          id: `task-${taskId++}`,
          type: 'quiz',
          topic: topic.name,
          title: `Take a ${questionCount} question quiz`,
          description: `Test your knowledge of ${topic.name}`,
          estimatedTime: `${Math.round(questionCount * 2.5)} mins`,
          estimatedMinutes: Math.round(questionCount * 2.5),
          questionCount,
          priority,
          completed: false
        });
      }
    }

    // If no tasks were generated, add some default tasks
    if (tasks.length === 0) {
      tasks.push({
        id: 'task-1',
        type: 'practice',
        topic: 'General',
        title: 'Start practicing with a quiz',
        description: 'Take your first quiz to get personalized recommendations',
        estimatedTime: '15 mins',
        estimatedMinutes: 15,
        priority: 'medium',
        completed: false
      });
    }

    // Calculate total time
    const totalMinutes = tasks.reduce((sum, t) => sum + t.estimatedMinutes, 0);
    const hours = Math.floor(totalMinutes / 60);
    const mins = totalMinutes % 60;
    const totalEstimatedTime = hours > 0 
      ? `${hours} hr${hours > 1 ? 's' : ''} ${mins > 0 ? `${mins} mins` : ''}`
      : `${mins} mins`;

    res.json({
      success: true,
      studyPlan: {
        id: `plan-${Date.now()}`,
        name: folderId ? 'Folder Study Plan' : 'Personalized Study Plan',
        createdAt: new Date().toISOString(),
        totalEstimatedTime,
        tasks
      }
    });
  } catch (error) {
    console.error('Error generating study plan:', error);
    res.status(500).json({ error: error.message });
  }
});

// Helper to format last practiced time
function formatLastPracticed(date) {
  if (!date) return null;
  
  const now = new Date();
  const practiced = new Date(date);
  const diffMs = now - practiced;
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  
  if (diffMins < 60) return 'Just now';
  if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} week${Math.floor(diffDays / 7) > 1 ? 's' : ''} ago`;
  return `${Math.floor(diffDays / 30)} month${Math.floor(diffDays / 30) > 1 ? 's' : ''} ago`;
}

// =====================
// QUIZ OPERATIONS
// =====================

/**
 * Generate and save a quiz
 * POST /api/practice/quizzes/generate
 */
router.post('/quizzes/generate', async (req, res) => {
  try {
    const { sectionIds, userId, questionCount, questionType, difficulty, name, folderId, description } = req.body;

    if (!sectionIds || sectionIds.length === 0) {
      return res.status(400).json({ error: 'At least one section ID is required' });
    }

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    const result = await generateQuizFromSections({
      sectionIds,
      userId,
      questionCount: parseInt(questionCount) || 10,
      questionType: questionType || 'multiple_choice',
      difficulty: difficulty || 'mixed',
      name,
      folderId,
      description
    });

    res.status(201).json({
      success: true,
      quiz: result
    });
  } catch (error) {
    console.error('Error generating quiz:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get a quiz with questions
 * GET /api/practice/quizzes/:quizId
 */
router.get('/quizzes/:quizId', async (req, res) => {
  try {
    const { quizId } = req.params;

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
 * Update quiz (move to folder, rename, etc.)
 * PUT /api/practice/quizzes/:quizId
 */
router.put('/quizzes/:quizId', async (req, res) => {
  try {
    const { quizId } = req.params;
    const { name, description, folderId } = req.body;

    const result = await query(
      `UPDATE quiz_sets 
       SET name = COALESCE($1, name),
           description = COALESCE($2, description),
           folder_id = $3
       WHERE id = $4 
       RETURNING *`,
      [name, description, folderId, quizId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Quiz not found' });
    }

    res.json({
      success: true,
      quiz: result.rows[0]
    });
  } catch (error) {
    console.error('Error updating quiz:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Delete a quiz
 * DELETE /api/practice/quizzes/:quizId
 */
router.delete('/quizzes/:quizId', async (req, res) => {
  try {
    const { quizId } = req.params;

    await deleteQuiz(quizId);

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting quiz:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Submit quiz attempt
 * POST /api/practice/quizzes/:quizId/attempt
 */
router.post('/quizzes/:quizId/attempt', async (req, res) => {
  try {
    const { quizId } = req.params;
    const { userId, answers, timeTaken } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    if (!answers || typeof answers !== 'object') {
      return res.status(400).json({ error: 'Answers are required' });
    }

    // Get quiz with questions
    const quiz = await getQuiz(quizId);

    if (!quiz) {
      return res.status(404).json({ error: 'Quiz not found' });
    }

    // Score the quiz
    let correct = 0;
    const total = quiz.questions.length;
    const detailedAnswers = {};

    for (const question of quiz.questions) {
      const userAnswer = answers[question.id];
      const isCorrect = userAnswer === question.correct_answer;

      if (isCorrect) correct++;

      detailedAnswers[question.id] = {
        answer: userAnswer,
        isCorrect,
        correctAnswer: question.correct_answer
      };
    }

    const percentage = Math.round((correct / total) * 100);

    // Save attempt
    await query(
      `INSERT INTO quiz_attempts (quiz_set_id, user_id, score, total_questions, percentage, answers, time_taken)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [quizId, userId, correct, total, percentage, JSON.stringify(detailedAnswers), timeTaken || null]
    );

    // Update quiz stats
    await query(
      `UPDATE quiz_sets 
       SET attempt_count = attempt_count + 1,
           last_attempted_at = NOW(),
           best_score = GREATEST(COALESCE(best_score, 0), $1)
       WHERE id = $2`,
      [percentage, quizId]
    );

    res.json({
      success: true,
      score: {
        correct,
        total,
        percentage
      },
      results: Object.entries(detailedAnswers).map(([questionId, data]) => ({
        questionId,
        ...data,
        explanation: quiz.questions.find(q => q.id === questionId)?.explanation
      }))
    });
  } catch (error) {
    console.error('Error submitting quiz attempt:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get quiz attempts history
 * GET /api/practice/quizzes/:quizId/attempts
 */
router.get('/quizzes/:quizId/attempts', async (req, res) => {
  try {
    const { quizId } = req.params;

    const result = await query(
      `SELECT * FROM quiz_attempts 
       WHERE quiz_set_id = $1 
       ORDER BY completed_at DESC`,
      [quizId]
    );

    res.json({
      success: true,
      attempts: result.rows
    });
  } catch (error) {
    console.error('Error fetching quiz attempts:', error);
    res.status(500).json({ error: error.message });
  }
});

// =====================
// FLASHCARD OPERATIONS
// =====================

/**
 * Generate and save flashcards
 * POST /api/practice/flashcards/generate
 */
router.post('/flashcards/generate', async (req, res) => {
  try {
    const { sectionIds, userId, count, topic, name, folderId, description } = req.body;

    if (!sectionIds || sectionIds.length === 0) {
      return res.status(400).json({ error: 'At least one section ID is required' });
    }

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    const result = await generateFlashcardsFromSections({
      sectionIds,
      userId,
      count: parseInt(count) || 20,
      topic,
      name,
      folderId,
      description
    });

    res.status(201).json({
      success: true,
      flashcardSet: result
    });
  } catch (error) {
    console.error('Error generating flashcards:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get a flashcard set with cards
 * GET /api/practice/flashcards/:setId
 */
router.get('/flashcards/:setId', async (req, res) => {
  try {
    const { setId } = req.params;

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
 * Update flashcard set (move to folder, rename, etc.)
 * PUT /api/practice/flashcards/:setId
 */
router.put('/flashcards/:setId', async (req, res) => {
  try {
    const { setId } = req.params;
    const { name, description, folderId } = req.body;

    const result = await query(
      `UPDATE flashcard_sets 
       SET name = COALESCE($1, name),
           description = COALESCE($2, description),
           folder_id = $3
       WHERE id = $4 
       RETURNING *`,
      [name, description, folderId, setId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Flashcard set not found' });
    }

    res.json({
      success: true,
      flashcardSet: result.rows[0]
    });
  } catch (error) {
    console.error('Error updating flashcard set:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Delete a flashcard set
 * DELETE /api/practice/flashcards/:setId
 */
router.delete('/flashcards/:setId', async (req, res) => {
  try {
    const { setId } = req.params;

    await deleteFlashcardSet(setId);

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting flashcard set:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Record a flashcard study session
 * POST /api/practice/flashcards/:setId/session
 */
router.post('/flashcards/:setId/session', async (req, res) => {
  try {
    const { setId } = req.params;
    const { userId, cardsStudied, cardsMastered, timeSpent } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    // Save session
    await query(
      `INSERT INTO flashcard_sessions (flashcard_set_id, user_id, cards_studied, cards_mastered, time_spent)
       VALUES ($1, $2, $3, $4, $5)`,
      [setId, userId, cardsStudied || 0, cardsMastered || 0, timeSpent || null]
    );

    // Update flashcard set stats
    await query(
      `UPDATE flashcard_sets 
       SET last_studied_at = NOW(),
           mastery_count = GREATEST(COALESCE(mastery_count, 0), $1)
       WHERE id = $2`,
      [cardsMastered || 0, setId]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Error recording flashcard session:', error);
    res.status(500).json({ error: error.message });
  }
});

// =====================
// HELPER FUNCTIONS
// =====================

function buildPracticeFolderHierarchy(folders) {
  const folderMap = new Map();

  // Initialize folders
  folders.forEach(f => {
    folderMap.set(f.id, {
      id: f.id,
      name: f.name,
      description: f.description,
      color: f.color,
      icon: f.icon,
      parentFolderId: f.parent_folder_id,
      createdAt: f.created_at,
      subfolders: []
    });
  });

  // Build tree
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

export default router;
