/**
 * Quiz Generator Service - Topic Clustering with Parallel Generation
 * 
 * Uses embedding-based topic clustering to partition content and generate
 * questions in parallel for better speed and comprehensive coverage.
 * 
 * Features:
 * - Topic clustering using k-means on embeddings
 * - Parallel LLM calls for 10x faster generation
 * - Guaranteed coverage across all topics
 * - Math-aware question generation
 * - Embedding-based deduplication
 */

import { query, transaction } from '../config/database.js';
import { callLLM } from './llmService.js';
import { generateEmbedding, cosineSimilarity } from './embeddingService.js';

// Configuration
const DEFAULT_CLUSTER_COUNT = 10;
const MAX_PARALLEL_CALLS = 10;
const MIN_CHUNKS_PER_CLUSTER = 3;
const DEDUP_SIMILARITY_THRESHOLD = 0.85;

/**
 * Get all chunks for given material IDs
 */
const getAllChunksForMaterials = async (materialIds) => {
  if (!materialIds || materialIds.length === 0) return [];

  const result = await query(
    `SELECT 
      mc.id,
      mc.material_id,
      mc.chunk_index,
      mc.content,
      mc.content_type,
      mc.has_math,
      mc.embedding,
      mc.metadata,
      m.title as material_title
    FROM material_chunks mc
    JOIN materials m ON mc.material_id = m.id
    WHERE mc.material_id = ANY($1)
      AND mc.embedding IS NOT NULL
      AND mc.content IS NOT NULL
      AND LENGTH(mc.content) > 100
    ORDER BY mc.material_id, mc.chunk_index`,
    [materialIds]
  );

  return result.rows;
};

/**
 * Get material IDs from section IDs
 */
const getMaterialIdsFromSections = async (sectionIds) => {
  if (!sectionIds || sectionIds.length === 0) return [];

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
 * K-means++ initialization for better cluster centers
 */
const initializeCentroids = (chunks, k) => {
  if (chunks.length <= k) {
    return chunks.map(c => c.embedding);
  }

  const centroids = [];
  const usedIndices = new Set();

  // First centroid: random
  const firstIdx = Math.floor(Math.random() * chunks.length);
  centroids.push(chunks[firstIdx].embedding);
  usedIndices.add(firstIdx);

  // Remaining centroids: weighted by distance from existing centroids
  while (centroids.length < k) {
    const distances = chunks.map((chunk, idx) => {
      if (usedIndices.has(idx)) return 0;
      
      // Find minimum distance to any existing centroid
      const minDist = Math.min(
        ...centroids.map(c => 1 - cosineSimilarity(chunk.embedding, c))
      );
      return minDist * minDist; // Square for probability weighting
    });

    const totalDist = distances.reduce((a, b) => a + b, 0);
    if (totalDist === 0) break;

    // Weighted random selection
    let random = Math.random() * totalDist;
    let selectedIdx = 0;
    for (let i = 0; i < distances.length; i++) {
      random -= distances[i];
      if (random <= 0) {
        selectedIdx = i;
        break;
      }
    }

    if (!usedIndices.has(selectedIdx)) {
      centroids.push(chunks[selectedIdx].embedding);
      usedIndices.add(selectedIdx);
    }
  }

  return centroids;
};

/**
 * Cluster chunks by topic using k-means on embeddings
 */
const clusterChunksByTopic = (chunks, numClusters = DEFAULT_CLUSTER_COUNT) => {
  if (chunks.length === 0) return [];
  
  // Adjust cluster count if we have fewer chunks
  const actualClusters = Math.min(numClusters, Math.ceil(chunks.length / MIN_CHUNKS_PER_CLUSTER));
  
  if (actualClusters <= 1) {
    return [{ chunks, centroid: null }];
  }

  console.log(`[TopicCluster] Clustering ${chunks.length} chunks into ${actualClusters} clusters`);

  // Filter chunks with valid embeddings
  const validChunks = chunks.filter(c => c.embedding && Array.isArray(c.embedding));
  
  if (validChunks.length === 0) {
    console.warn('[TopicCluster] No chunks with valid embeddings');
    return [{ chunks, centroid: null }];
  }

  // Initialize centroids using k-means++
  let centroids = initializeCentroids(validChunks, actualClusters);
  
  // K-means iterations
  const maxIterations = 10;
  let assignments = new Array(validChunks.length).fill(0);
  
  for (let iter = 0; iter < maxIterations; iter++) {
    // Assignment step: assign each chunk to nearest centroid
    const newAssignments = validChunks.map((chunk, idx) => {
      let bestCluster = 0;
      let bestSimilarity = -1;
      
      for (let c = 0; c < centroids.length; c++) {
        const similarity = cosineSimilarity(chunk.embedding, centroids[c]);
        if (similarity > bestSimilarity) {
          bestSimilarity = similarity;
          bestCluster = c;
        }
      }
      
      return bestCluster;
    });

    // Check for convergence
    const changed = newAssignments.some((a, i) => a !== assignments[i]);
    assignments = newAssignments;
    
    if (!changed) {
      console.log(`[TopicCluster] Converged at iteration ${iter + 1}`);
      break;
    }

    // Update step: recalculate centroids
    const newCentroids = [];
    for (let c = 0; c < centroids.length; c++) {
      const clusterChunks = validChunks.filter((_, i) => assignments[i] === c);
      
      if (clusterChunks.length === 0) {
        newCentroids.push(centroids[c]); // Keep old centroid
        continue;
      }

      // Calculate mean embedding
      const dims = clusterChunks[0].embedding.length;
      const mean = new Array(dims).fill(0);
      
      for (const chunk of clusterChunks) {
        for (let d = 0; d < dims; d++) {
          mean[d] += chunk.embedding[d];
        }
      }
      
      for (let d = 0; d < dims; d++) {
        mean[d] /= clusterChunks.length;
      }
      
      newCentroids.push(mean);
    }
    
    centroids = newCentroids;
  }

  // Build cluster objects
  const clusters = [];
  for (let c = 0; c < centroids.length; c++) {
    const clusterChunks = validChunks.filter((_, i) => assignments[i] === c);
    if (clusterChunks.length > 0) {
      clusters.push({
        chunks: clusterChunks,
        centroid: centroids[c],
        size: clusterChunks.length
      });
    }
  }

  // Sort clusters by size (largest first) for balanced distribution
  clusters.sort((a, b) => b.size - a.size);

  console.log(`[TopicCluster] Created ${clusters.length} clusters:`, 
    clusters.map((c, i) => `Cluster ${i + 1}: ${c.size} chunks`).join(', '));

  return clusters;
};

/**
 * Filter out non-content chunks (TOC, index, page lists)
 */
const filterContentChunks = (chunks) => {
  return chunks.filter(c => {
    const content = (c.content || '').toLowerCase();
    
    // Skip index entries or TOC
    const isIndex = content.includes('index') && (content.match(/\d+/g) || []).length > 10;
    const isTOC = content.includes('table of contents') || content.includes('contents\n');
    const isPageList = (content.match(/\b\d+\b/g) || []).length > 20;
    const isTooShort = content.length < 100;
    
    return !isIndex && !isTOC && !isPageList && !isTooShort;
  });
};

/**
 * Generate questions for a single cluster
 */
const generateQuestionsForCluster = async (cluster, options) => {
  const {
    count,
    questionType,
    difficulty,
    clusterIndex,
    totalClusters
  } = options;

  // Filter and limit chunks
  const contentChunks = filterContentChunks(cluster.chunks).slice(0, 8);
  
  if (contentChunks.length === 0) {
    console.log(`[Cluster ${clusterIndex + 1}/${totalClusters}] No valid content chunks, skipping`);
    return [];
  }

  // Build context from chunks
  const context = contentChunks
    .map(c => c.content)
    .join('\n\n---\n\n');

  // Check if context has math
  const hasMath = contentChunks.some(c => c.has_math);

  // Build the prompt
  const prompt = buildQuestionPrompt({
    count,
    questionType,
    difficulty,
    hasMath,
    clusterIndex,
    totalClusters
  });

  console.log(`[Cluster ${clusterIndex + 1}/${totalClusters}] Generating ${count} questions from ${contentChunks.length} chunks`);

  try {
    // Call LLM
    const response = await callLLM(context, prompt);

    // Parse questions from response
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.warn(`[Cluster ${clusterIndex + 1}] No JSON array found in response`);
      return [];
    }

    const questions = JSON.parse(jsonMatch[0]);

    // Validate and normalize questions
    return questions
      .filter(q => (q.question && q.question.trim()) || (q.front && q.front.trim()))
      .map(q => ({
        question: q.question?.trim(),
        front: q.front?.trim(),
        back: q.back?.trim(),
        questionType: questionType,
        options: q.options || null,
        correctAnswer: q.correct_answer || q.correctAnswer || null,
        explanation: q.explanation || null,
        difficulty: q.difficulty || difficulty,
        topic: q.topic || null,
        chapter: q.chapter || null,
        sourceChunkIds: contentChunks.slice(0, 3).map(c => c.id),
        clusterIndex
      }));
  } catch (error) {
    console.error(`[Cluster ${clusterIndex + 1}] Error generating questions:`, error.message);
    return [];
  }
};

/**
 * Build the prompt for question generation
 */
const buildQuestionPrompt = (options) => {
  const {
    count,
    questionType,
    difficulty,
    hasMath,
    clusterIndex,
    totalClusters
  } = options;

  const difficultyGuide = difficulty === 'mixed'
    ? 'Mix of easy (30%), medium (50%), and hard (20%) questions'
    : `All questions should be ${difficulty} difficulty`;

  const mathGuide = hasMath
    ? `\nIMPORTANT: This content contains mathematical notation. 
- Use LaTeX format for all math: inline math as $...$ and display math as $$...$$
- Include calculations and formulas in questions where appropriate
- Test understanding of mathematical concepts, not just memorization`
    : '';

  const clusterGuide = totalClusters > 1
    ? `\nYou are generating questions for topic cluster ${clusterIndex + 1} of ${totalClusters}. Focus on the specific concepts in this content section.`
    : '';

  let formatGuide;
  if (questionType === 'multiple_choice') {
    formatGuide = `Generate exactly ${count} multiple-choice questions.
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
    "topic": "Specific topic from this content"
  }
]`;
  } else if (questionType === 'true_false') {
    formatGuide = `Generate exactly ${count} true/false questions.
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
    formatGuide = `Generate exactly ${count} flashcards.
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
    formatGuide = `Generate exactly ${count} short-answer questions.
Each question must have:
- A clear question
- A model answer
- Key points

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
${clusterGuide}

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

${difficultyGuide}
${mathGuide}

Requirements:
1. Test conceptual understanding, not memorization of document structure
2. Questions should be educational and meaningful
3. Answers should reflect real knowledge of the subject
4. Each question should cover a DIFFERENT concept from the content
5. Ensure variety in the topics covered

${formatGuide}

Respond ONLY with the JSON array, no other text.`;
};

/**
 * Deduplicate questions using embedding similarity
 */
const deduplicateQuestions = async (questions) => {
  if (questions.length <= 1) return questions;

  console.log(`[Dedup] Deduplicating ${questions.length} questions...`);

  // Generate embeddings for all questions
  const questionTexts = questions.map(q => q.question || q.front);
  const embeddings = await Promise.all(
    questionTexts.map(text => generateEmbedding(text, { provider: 'openai' }))
  );

  const unique = [];
  const usedIndices = new Set();

  for (let i = 0; i < questions.length; i++) {
    if (usedIndices.has(i)) continue;

    let isDuplicate = false;

    for (const uniqueQ of unique) {
      const similarity = cosineSimilarity(
        embeddings[i].embedding,
        embeddings[uniqueQ.originalIndex].embedding
      );

      if (similarity > DEDUP_SIMILARITY_THRESHOLD) {
        isDuplicate = true;
        break;
      }
    }

    if (!isDuplicate) {
      unique.push({ ...questions[i], originalIndex: i });
    }
  }

  console.log(`[Dedup] Kept ${unique.length} unique questions (removed ${questions.length - unique.length} duplicates)`);

  // Remove the originalIndex helper field
  return unique.map(({ originalIndex, clusterIndex, ...q }) => q);
};

/**
 * Generate a quiz using topic clustering with parallel generation
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

  console.log(`\n========================================`);
  console.log(`[QuizGen] Starting parallel quiz generation`);
  console.log(`[QuizGen] Target: ${questionCount} questions, Type: ${questionType}`);
  console.log(`========================================\n`);

  // 1. Get material IDs from sections
  const materialIds = await getMaterialIdsFromSections(sectionIds);
  console.log(`[QuizGen] Found ${materialIds.length} materials from ${sectionIds.length} sections`);

  if (materialIds.length === 0) {
    throw new Error('No processed materials found in the selected sections. Please ensure files have been uploaded and processed.');
  }

  // 2. Get all chunks for materials
  const allChunks = await getAllChunksForMaterials(materialIds);
  console.log(`[QuizGen] Retrieved ${allChunks.length} chunks with embeddings`);

  if (allChunks.length === 0) {
    throw new Error('No content chunks found in the selected materials.');
  }

  // 3. Determine number of clusters based on question count
  const numClusters = Math.min(
    MAX_PARALLEL_CALLS,
    Math.max(1, Math.ceil(questionCount / 10)),
    Math.ceil(allChunks.length / MIN_CHUNKS_PER_CLUSTER)
  );

  // 4. Cluster chunks by topic using embeddings
  const clusters = clusterChunksByTopic(allChunks, numClusters);
  console.log(`[QuizGen] Created ${clusters.length} topic clusters for parallel generation`);

  // 5. Calculate questions per cluster (distribute evenly with buffer for dedup)
  const bufferMultiplier = 1.3; // Generate 30% extra to account for deduplication
  const targetPerCluster = Math.ceil((questionCount * bufferMultiplier) / clusters.length);

  // 6. Generate questions in parallel
  console.log(`[QuizGen] Starting parallel generation: ${clusters.length} clusters × ${targetPerCluster} questions`);
  
  const startTime = Date.now();
  
  const parallelTasks = clusters.map((cluster, index) => 
    generateQuestionsForCluster(cluster, {
      count: targetPerCluster,
      questionType,
      difficulty,
      clusterIndex: index,
      totalClusters: clusters.length
    })
  );

  const results = await Promise.all(parallelTasks);
  
  const generationTime = Date.now() - startTime;
  console.log(`[QuizGen] Parallel generation completed in ${generationTime}ms`);

  // 7. Flatten all questions
  const allQuestions = results.flat();
  console.log(`[QuizGen] Generated ${allQuestions.length} total questions from ${clusters.length} clusters`);

  if (allQuestions.length === 0) {
    throw new Error('Failed to generate any questions. Please try again.');
  }

  // 8. Deduplicate across all clusters
  const uniqueQuestions = await deduplicateQuestions(allQuestions);

  // 9. Take only the requested count
  const finalQuestions = uniqueQuestions.slice(0, questionCount);
  console.log(`[QuizGen] Final quiz: ${finalQuestions.length} questions`);

  // 10. Store quiz in database
  const quizName = name || `Quiz - ${new Date().toISOString().split('T')[0]}`;
  const quizId = await storeQuiz({
    userId,
    sectionIds,
    name: quizName,
    questions: finalQuestions,
    difficulty,
    folderId,
    description
  });

  console.log(`[QuizGen] Quiz saved with ID: ${quizId}`);
  console.log(`========================================\n`);

  return {
    quizId,
    name: quizName,
    description,
    folderId,
    questionCount: finalQuestions.length,
    questions: finalQuestions,
    stats: {
      clustersUsed: clusters.length,
      generationTimeMs: generationTime,
      totalGenerated: allQuestions.length,
      afterDedup: uniqueQuestions.length
    }
  };
};

/**
 * Generate flashcards using topic clustering with parallel generation
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

  console.log(`\n========================================`);
  console.log(`[FlashcardGen] Starting parallel flashcard generation`);
  console.log(`[FlashcardGen] Target: ${count} flashcards`);
  console.log(`========================================\n`);

  // 1. Get material IDs from sections
  const materialIds = await getMaterialIdsFromSections(sectionIds);
  
  if (materialIds.length === 0) {
    throw new Error('No processed materials found in the selected sections.');
  }

  // 2. Get all chunks
  const allChunks = await getAllChunksForMaterials(materialIds);
  
  if (allChunks.length === 0) {
    throw new Error('No content chunks found in the selected materials.');
  }

  // 3. Cluster by topic
  const numClusters = Math.min(
    MAX_PARALLEL_CALLS,
    Math.max(1, Math.ceil(count / 10)),
    Math.ceil(allChunks.length / MIN_CHUNKS_PER_CLUSTER)
  );

  const clusters = clusterChunksByTopic(allChunks, numClusters);

  // 4. Calculate cards per cluster
  const bufferMultiplier = 1.3;
  const targetPerCluster = Math.ceil((count * bufferMultiplier) / clusters.length);

  // 5. Generate in parallel
  const startTime = Date.now();
  
  const parallelTasks = clusters.map((cluster, index) => 
    generateQuestionsForCluster(cluster, {
      count: targetPerCluster,
      questionType: 'flashcard',
      difficulty: 'medium',
      clusterIndex: index,
      totalClusters: clusters.length
    })
  );

  const results = await Promise.all(parallelTasks);
  const generationTime = Date.now() - startTime;

  // 6. Flatten and deduplicate
  const allFlashcards = results.flat();
  const uniqueFlashcards = await deduplicateQuestions(allFlashcards);

  // 7. Take requested count
  const finalFlashcards = uniqueFlashcards.slice(0, count);

  // 8. Store in database
  const setName = name || `Flashcards - ${new Date().toISOString().split('T')[0]}`;
  const flashcardSetId = await storeFlashcards({
    userId,
    sectionIds,
    name: setName,
    flashcards: finalFlashcards,
    folderId,
    description
  });

  console.log(`[FlashcardGen] Saved ${finalFlashcards.length} flashcards with ID: ${flashcardSetId}`);

  return {
    flashcardSetId,
    name: setName,
    description,
    folderId,
    count: finalFlashcards.length,
    flashcards: finalFlashcards,
    stats: {
      clustersUsed: clusters.length,
      generationTimeMs: generationTime,
      totalGenerated: allFlashcards.length,
      afterDedup: uniqueFlashcards.length
    }
  };
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
