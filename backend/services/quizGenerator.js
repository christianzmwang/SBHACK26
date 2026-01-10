/**
 * Quiz Generator Service
 * 
 * Generates quizzes and flashcards using RAG-enhanced LLM calls.
 * Supports:
 * - Multiple choice questions
 * - True/False questions
 * - Short answer questions
 * - Flashcards
 * 
 * Features:
 * - Section-based generation (from folder materials)
 * - Math-aware question generation
 * - Batch processing for large quizzes
 * - Deduplication
 */

import { query, transaction } from '../config/database.js';
import { retrieveRelevantChunks } from './ragRetriever.js';
import { callLLM } from './llmService.js';
import { generateEmbedding, cosineSimilarity } from './embeddingService.js';

// Constants
const BATCH_SIZE = 10; // Questions per LLM call

/**
 * Get material IDs from section IDs
 * @param {string[]} sectionIds - Array of section IDs
 * @returns {string[]} - Array of material IDs
 */
const getMaterialIdsFromSections = async (sectionIds) => {
  if (!sectionIds || sectionIds.length === 0) {
    return [];
  }

  const result = await query(
    `SELECT DISTINCT material_id 
     FROM section_files 
     WHERE section_id = ANY($1) 
       AND material_id IS NOT NULL`,
    [sectionIds]
  );

  return result.rows.map(r => r.material_id);
};

/**
 * Generate a quiz from specific sections (folder materials)
 * 
 * @param {Object} options - Generation options
 * @returns {Object} - Generated quiz with questions
 */
export const generateQuizFromSections = async (options) => {
  const {
    sectionIds,
    userId,
    questionCount = 20,
    questionType = 'multiple_choice',
    difficulty = 'mixed',
    name = null,
    folderId = null,
    description = null
  } = options;

  if (!sectionIds || sectionIds.length === 0) {
    throw new Error('At least one section ID is required');
  }

  if (!userId) {
    throw new Error('User ID is required');
  }

  // Get material IDs from sections
  const materialIds = await getMaterialIdsFromSections(sectionIds);

  console.log(`[QuizGenerator] Section IDs: ${sectionIds.join(', ')}`);
  console.log(`[QuizGenerator] Material IDs found: ${materialIds.length > 0 ? materialIds.join(', ') : 'NONE'}`);

  if (materialIds.length === 0) {
    throw new Error('No processed materials found in the selected sections. Please ensure files have been uploaded and processed.');
  }

  const allQuestions = [];
  const totalBatches = Math.ceil(questionCount / BATCH_SIZE);

  for (let batch = 0; batch < totalBatches; batch++) {
    const batchCount = Math.min(BATCH_SIZE, questionCount - allQuestions.length);
    
    // Retrieve relevant chunks from the materials - use broader query
    const chunks = await retrieveRelevantChunks('important concepts terms definitions facts information', {
      materialIds,
      topK: 20,
      similarityThreshold: 0.2 // Lower threshold to get more content
    });

    console.log(`[QuizGenerator] Batch ${batch + 1}: Retrieved ${chunks.length} chunks`);
    if (chunks.length > 0) {
      console.log(`[QuizGenerator] Sample chunk topics: ${chunks.slice(0, 3).map(c => c.material_title || 'unknown').join(', ')}`);
    }

    if (chunks.length === 0 && batch === 0) {
      throw new Error('No content chunks found in the selected materials.');
    }

    if (chunks.length > 0) {
      const questions = await generateQuestionBatch({
        chunks,
        count: batchCount,
        questionType,
        difficulty,
        existingQuestions: allQuestions
      });

      allQuestions.push(...questions);
    }

    // Rate limiting between batches
    if (batch < totalBatches - 1) {
      await sleep(500);
    }
  }

  // Deduplicate questions
  const uniqueQuestions = await deduplicateQuestions(allQuestions);

  // Store quiz in database
  const quizName = name || `Quiz - ${new Date().toISOString().split('T')[0]}`;
  const quizId = await storeQuiz({
    userId,
    sectionIds,
    name: quizName,
    questions: uniqueQuestions,
    difficulty,
    folderId,
    description
  });

  return {
    quizId,
    name: quizName,
    description,
    folderId,
    questionCount: uniqueQuestions.length,
    questions: uniqueQuestions
  };
};

/**
 * Generate flashcards from specific sections
 */
export const generateFlashcardsFromSections = async (options) => {
  const {
    sectionIds,
    userId,
    count = 20,
    topic = null,
    name = null,
    folderId = null,
    description = null
  } = options;

  if (!sectionIds || sectionIds.length === 0) {
    throw new Error('At least one section ID is required');
  }

  if (!userId) {
    throw new Error('User ID is required');
  }

  // Get material IDs from sections
  const materialIds = await getMaterialIdsFromSections(sectionIds);

  console.log(`[FlashcardGenerator] Section IDs: ${sectionIds.join(', ')}`);
  console.log(`[FlashcardGenerator] Material IDs found: ${materialIds.length > 0 ? materialIds.join(', ') : 'NONE'}`);

  if (materialIds.length === 0) {
    throw new Error('No processed materials found in the selected sections.');
  }

  // Retrieve relevant content
  const searchQuery = topic || 'important concepts terms definitions facts information';
  const chunks = await retrieveRelevantChunks(searchQuery, {
    materialIds,
    topK: Math.min(30, count * 2),
    similarityThreshold: 0.2 // Lower threshold to get more content
  });

  console.log(`[FlashcardGenerator] Retrieved ${chunks.length} chunks`);
  if (chunks.length > 0) {
    console.log(`[FlashcardGenerator] Sample topics: ${chunks.slice(0, 3).map(c => c.material_title || 'unknown').join(', ')}`);
  }

  if (chunks.length === 0) {
    throw new Error('No content chunks found in the selected materials.');
  }

  // Generate flashcards
  const allFlashcards = [];
  const batches = Math.ceil(count / BATCH_SIZE);

  for (let i = 0; i < batches; i++) {
    const batchCount = Math.min(BATCH_SIZE, count - allFlashcards.length);

    const batch = await generateQuestionBatch({
      chunks,
      topic,
      count: batchCount,
      questionType: 'flashcard',
      difficulty: 'medium',
      existingQuestions: allFlashcards
    });

    allFlashcards.push(...batch);

    if (i < batches - 1) {
      await sleep(500);
    }
  }

  // Store flashcards
  const setName = name || `Flashcards - ${new Date().toISOString().split('T')[0]}`;
  const flashcardSetId = await storeFlashcards({
    userId,
    sectionIds,
    name: setName,
    flashcards: allFlashcards,
    folderId,
    description
  });

  return {
    flashcardSetId,
    name: setName,
    description,
    folderId,
    count: allFlashcards.length,
    flashcards: allFlashcards
  };
};

/**
 * Generate a batch of questions using LLM
 */
const generateQuestionBatch = async (options) => {
  const {
    chunks,
    topic = null,
    learningObjectives = null,
    count,
    questionType,
    difficulty,
    existingQuestions = []
  } = options;

  // Filter out index, TOC, and other non-content chunks
  const contentChunks = chunks.filter(c => {
    const content = (c.content || '').toLowerCase();
    // Skip chunks that look like index entries or TOC
    const isIndex = content.includes('index') && (content.match(/\d+/g) || []).length > 10;
    const isTOC = content.includes('table of contents') || content.includes('contents\n');
    const isPageList = (content.match(/\b\d+\b/g) || []).length > 20; // Many page numbers
    const isTooShort = content.length < 100;
    
    if (isIndex || isTOC || isPageList || isTooShort) {
      console.log(`[QuizGenerator] Skipping non-content chunk: ${content.substring(0, 50)}...`);
      return false;
    }
    return true;
  });

  // Build context from filtered chunks
  const context = contentChunks
    .slice(0, 10) // Limit to top 10 chunks
    .map(c => c.content)
    .join('\n\n---\n\n');

  // Log context preview for debugging
  console.log(`[QuizGenerator] Using ${contentChunks.length} content chunks (filtered from ${chunks.length})`);
  console.log(`[QuizGenerator] Context length: ${context.length} chars`);
  console.log(`[QuizGenerator] Context preview (first 500 chars): ${context.substring(0, 500)}...`);

  // Check if context has math
  const hasMath = chunks.some(c => c.has_math);

  // Build existing questions text for deduplication prompt
  const existingQuestionsText = existingQuestions.length > 0
    ? existingQuestions.slice(-20).map(q => `- ${q.question || q.front}`).join('\n')
    : 'None yet';

  // Build the prompt based on question type
  const prompt = buildQuestionPrompt({
    context,
    topic,
    learningObjectives,
    count,
    questionType,
    difficulty,
    hasMath,
    existingQuestionsText
  });

  // Call LLM
  const response = await callLLM(context, prompt);

  // Parse questions from response
  let questions;
  try {
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      questions = JSON.parse(jsonMatch[0]);
    } else {
      throw new Error('No JSON array found');
    }
  } catch (error) {
    console.error('Failed to parse questions:', error.message);
    console.error('Response:', response.substring(0, 500));
    return [];
  }

  // Validate and normalize questions
  return questions
    .filter(q => (q.question && q.question.trim()) || (q.front && q.front.trim()))
    .map((q) => ({
      question: q.question?.trim(),
      front: q.front?.trim(),
      back: q.back?.trim(),
      questionType: questionType,
      options: q.options || null,
      correctAnswer: q.correct_answer || q.correctAnswer || null,
      explanation: q.explanation || null,
      difficulty: q.difficulty || difficulty,
      topic: topic || q.topic || null,
      chapter: q.chapter || null,
      sourceChunkIds: chunks.slice(0, 5).map(c => c.id)
    }));
};

/**
 * Build the prompt for question generation
 */
const buildQuestionPrompt = (options) => {
  const {
    topic,
    learningObjectives,
    count,
    questionType,
    difficulty,
    hasMath,
    existingQuestionsText
  } = options;

  const difficultyGuide = difficulty === 'mixed'
    ? 'Mix of easy (30%), medium (50%), and hard (20%) questions'
    : `All questions should be ${difficulty} difficulty`;

  const topicGuide = topic
    ? `Focus on the topic: "${topic}"`
    : 'Cover the main concepts from the content';

  const objectivesGuide = learningObjectives && learningObjectives.length > 0
    ? `\nLearning objectives to address:\n${learningObjectives.map(o => `- ${o}`).join('\n')}`
    : '';

  const mathGuide = hasMath
    ? `\nIMPORTANT: This content contains mathematical notation. 
- Use LaTeX format for all math: inline math as $...$ and display math as $$...$$
- Include calculations and formulas in questions where appropriate
- Test understanding of mathematical concepts, not just memorization`
    : '';

  let formatGuide;
  if (questionType === 'multiple_choice') {
    formatGuide = `Generate ${count} multiple-choice questions.
Each question must have:
- A clear question
- 4 options (A, B, C, D)
- One correct answer
- A brief explanation

JSON format:
[
  {
    "question": "Question text here?",
    "options": {"A": "Option A", "B": "Option B", "C": "Option C", "D": "Option D"},
    "correct_answer": "A",
    "explanation": "Brief explanation of why A is correct",
    "difficulty": "medium",
    "topic": "Specific topic"
  }
]`;
  } else if (questionType === 'true_false') {
    formatGuide = `Generate ${count} true/false questions.
Each question must have:
- A statement that is either true or false
- The correct answer (true or false)
- An explanation

JSON format:
[
  {
    "question": "Statement here",
    "correct_answer": "true",
    "explanation": "Why this is true/false",
    "difficulty": "medium"
  }
]`;
  } else if (questionType === 'flashcard') {
    formatGuide = `Generate ${count} flashcards.
Each flashcard must have:
- A front (question or term)
- A back (answer or definition)

JSON format:
[
  {
    "front": "Term or question",
    "back": "Definition or answer",
    "topic": "Specific topic"
  }
]`;
  } else {
    formatGuide = `Generate ${count} short-answer questions.
Each question must have:
- A clear question
- A model answer
- Key points to include

JSON format:
[
  {
    "question": "Question text?",
    "model_answer": "Expected answer",
    "key_points": ["point 1", "point 2"],
    "difficulty": "medium"
  }
]`;
  }

  return `You are creating educational quiz questions to test understanding of the subject matter.

ABSOLUTE RULES - NEVER VIOLATE THESE:
1. NEVER use phrases like "according to the text", "the text states", "in the passage", "the author mentions", or ANY reference to "the text/passage/document/reading"
2. NEVER ask about page numbers, index entries, or chapter numbers
3. NEVER ask about book metadata (who wrote it, publication info, etc.)
4. Questions must be STANDALONE - they should make sense without any source document

Write questions as if you are a subject matter expert testing knowledge, NOT as if you are testing reading comprehension of a document.

GOOD QUESTION EXAMPLES:
- "What is the primary function of X in Y?"
- "How does A relate to B?"
- "What characterizes X?"
- "Why is X significant in the field of Y?"

BAD QUESTION EXAMPLES (NEVER CREATE THESE):
- "According to the text, what characterizes X?" ❌
- "What does the passage say about X?" ❌
- "Based on the reading, how does X work?" ❌
- "The author describes X as what?" ❌

${topicGuide}${objectivesGuide}
${difficultyGuide}
${mathGuide}

Requirements:
1. Test conceptual understanding, not memorization of document structure
2. Questions should be educational and meaningful
3. Answers should reflect real knowledge of the subject
4. Avoid these existing questions to prevent duplicates:
${existingQuestionsText}

${formatGuide}

Respond ONLY with the JSON array, no other text.`;
};

/**
 * Deduplicate questions using embedding similarity
 */
const deduplicateQuestions = async (questions) => {
  if (questions.length <= 1) return questions;

  // Generate embeddings for all questions
  const embeddings = await Promise.all(
    questions.map(q => generateEmbedding(q.question || q.front, { provider: 'openai' }))
  );

  const unique = [];
  const usedIndices = new Set();

  for (let i = 0; i < questions.length; i++) {
    if (usedIndices.has(i)) continue;

    let isDuplicate = false;

    for (let j = 0; j < unique.length; j++) {
      const similarity = cosineSimilarity(
        embeddings[i].embedding,
        embeddings[unique[j].originalIndex].embedding
      );

      if (similarity > 0.9) {
        isDuplicate = true;
        break;
      }
    }

    if (!isDuplicate) {
      unique.push({ ...questions[i], originalIndex: i });
    }
  }

  // Remove the originalIndex helper field
  return unique.map(({ originalIndex, ...q }) => q);
};

/**
 * Store quiz in database
 */
const storeQuiz = async (options) => {
  const { userId, sectionIds, name, questions, difficulty, folderId, description } = options;

  return await transaction(async (client) => {
    // Create quiz set
    const quizResult = await client.query(
      `INSERT INTO quiz_sets 
       (user_id, section_ids, name, total_questions, difficulty, folder_id, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [userId, sectionIds, name, questions.length, difficulty, folderId || null, description || null]
    );

    const quizId = quizResult.rows[0].id;

    // Insert questions
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];

      await client.query(
        `INSERT INTO questions 
         (quiz_set_id, question_index, question, question_type, options, correct_answer, 
          explanation, difficulty, topic, chapter, source_chunk_ids)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          quizId,
          i,
          q.question,
          q.questionType,
          JSON.stringify(q.options),
          q.correctAnswer,
          q.explanation,
          q.difficulty,
          q.topic,
          q.chapter,
          q.sourceChunkIds || []
        ]
      );
    }

    return quizId;
  });
};

/**
 * Store flashcards in database
 */
const storeFlashcards = async (options) => {
  const { userId, sectionIds, name, flashcards, folderId, description } = options;

  return await transaction(async (client) => {
    const setResult = await client.query(
      `INSERT INTO flashcard_sets (user_id, section_ids, name, total_cards, folder_id, description)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [userId, sectionIds, name, flashcards.length, folderId || null, description || null]
    );

    const setId = setResult.rows[0].id;

    for (const card of flashcards) {
      await client.query(
        `INSERT INTO flashcards (flashcard_set_id, front, back, topic, chapter)
         VALUES ($1, $2, $3, $4, $5)`,
        [setId, card.front || card.question, card.back || card.explanation, card.topic, card.chapter]
      );
    }

    return setId;
  });
};

/**
 * Get quiz by ID
 */
export const getQuiz = async (quizId) => {
  const quizResult = await query(
    'SELECT * FROM quiz_sets WHERE id = $1',
    [quizId]
  );

  if (quizResult.rows.length === 0) {
    return null;
  }

  const questionsResult = await query(
    `SELECT id, question_index, question, question_type, options, correct_answer,
            explanation, difficulty, topic, chapter
     FROM questions
     WHERE quiz_set_id = $1
     ORDER BY question_index`,
    [quizId]
  );

  return {
    ...quizResult.rows[0],
    questions: questionsResult.rows
  };
};

/**
 * Get quizzes for a user
 */
export const getQuizzesByUser = async (userId) => {
  const result = await query(
    `SELECT id, name, total_questions, difficulty, created_at, section_ids
     FROM quiz_sets
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId]
  );

  return result.rows;
};

/**
 * Get flashcard sets for a user
 */
export const getFlashcardSetsByUser = async (userId) => {
  const result = await query(
    `SELECT id, name, total_cards, created_at, section_ids
     FROM flashcard_sets
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId]
  );

  return result.rows;
};

/**
 * Get flashcard set by ID
 */
export const getFlashcardSet = async (setId) => {
  const setResult = await query(
    'SELECT * FROM flashcard_sets WHERE id = $1',
    [setId]
  );

  if (setResult.rows.length === 0) {
    return null;
  }

  const cardsResult = await query(
    `SELECT id, front, back, topic, chapter, difficulty
     FROM flashcards
     WHERE flashcard_set_id = $1
     ORDER BY id`,
    [setId]
  );

  return {
    ...setResult.rows[0],
    cards: cardsResult.rows
  };
};

/**
 * Delete quiz
 */
export const deleteQuiz = async (quizId) => {
  await query('DELETE FROM quiz_sets WHERE id = $1', [quizId]);
  return true;
};

/**
 * Delete flashcard set
 */
export const deleteFlashcardSet = async (setId) => {
  await query('DELETE FROM flashcard_sets WHERE id = $1', [setId]);
  return true;
};

// Utility
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export default {
  generateQuizFromSections,
  generateFlashcardsFromSections,
  getQuiz,
  getQuizzesByUser,
  getFlashcardSetsByUser,
  getFlashcardSet,
  deleteQuiz,
  deleteFlashcardSet
};
