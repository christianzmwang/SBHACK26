/**
 * Quiz Generator Service - Chapter-Balanced Coverage
 * 
 * Generates practice questions with proportional coverage across all chapters
 * and topics in the uploaded material.
 * 
 * Features:
 * - Chapter-aware question distribution (proportional to content size)
 * - Topic diversity within chapters using embedding clustering
 * - Parallel LLM calls for speed
 * - Math-aware question generation
 * - Embedding-based deduplication
 */

import { query, transaction } from '../config/database.js';
import { callLLM } from './llmService.js';
import { generateEmbedding, cosineSimilarity } from './embeddingService.js';

// Configuration
const CONCURRENCY_LIMIT = 10;
const MIN_CHUNKS_PER_GROUP = 2;
const DEDUP_SIMILARITY_THRESHOLD = 0.85;

/**
 * Run tasks in batches to respect rate limits
 */
const runInBatches = async (items, batchSize, fn) => {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    console.log(`[Batch] Processing items ${i + 1} to ${Math.min(i + batchSize, items.length)} of ${items.length}`);
    const batchResults = await Promise.all(
      batch.map((item, index) => fn(item, i + index))
    );
    results.push(...batchResults);
  }
  return results;
};

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
 * Get material structure (chapters/topics) from database
 */
const getMaterialStructure = async (materialIds) => {
  if (!materialIds || materialIds.length === 0) return [];

  const result = await query(
    `SELECT id, title, metadata FROM materials WHERE id = ANY($1)`,
    [materialIds]
  );

  return result.rows.map(row => ({
    materialId: row.id,
    title: row.title,
    structure: row.metadata?.structure || { chapters: [], totalTopics: 0, hasStructure: false }
  }));
};

/**
 * Group chunks by chapter for balanced distribution
 * Returns an array of chapter groups, each with its chunks
 */
const groupChunksByChapter = (chunks) => {
  const chapterGroups = new Map();
  const noChapter = [];

  for (const chunk of chunks) {
    const chapterNum = chunk.metadata?.chapter;
    const chapterTitle = chunk.metadata?.chapterTitle || `Chapter ${chapterNum}`;
    
    if (chapterNum) {
      const key = `${chunk.material_id}_ch${chapterNum}`;
      if (!chapterGroups.has(key)) {
        chapterGroups.set(key, {
          chapterNum,
          chapterTitle,
          materialId: chunk.material_id,
          materialTitle: chunk.material_title,
          chunks: []
        });
      }
      chapterGroups.get(key).chunks.push(chunk);
    } else {
      noChapter.push(chunk);
    }
  }

  // Convert to array and sort by chapter number
  const groups = Array.from(chapterGroups.values()).sort((a, b) => a.chapterNum - b.chapterNum);
  
  // If we have ungrouped chunks, add them as a "General" group
  if (noChapter.length > 0) {
    // If most chunks have no chapter, use topic clustering instead
    if (noChapter.length > chunks.length * 0.7) {
      return null; // Signal to use topic clustering instead
    }
    groups.push({
      chapterNum: 0,
      chapterTitle: 'General Content',
      materialId: null,
      chunks: noChapter
    });
  }

  return groups;
};

/**
 * Calculate question distribution across chapters (proportional to content)
 */
const calculateChapterDistribution = (chapterGroups, totalQuestions) => {
  const totalChunks = chapterGroups.reduce((sum, g) => sum + g.chunks.length, 0);
  
  // Calculate proportional distribution with minimum 1 question per chapter
  const distribution = chapterGroups.map(group => {
    const proportion = group.chunks.length / totalChunks;
    const rawQuestions = Math.round(totalQuestions * proportion);
    return {
      ...group,
      targetQuestions: Math.max(1, rawQuestions),
      proportion: (proportion * 100).toFixed(1) + '%'
    };
  });

  // Adjust to match exact total
  let currentTotal = distribution.reduce((sum, d) => sum + d.targetQuestions, 0);
  while (currentTotal < totalQuestions) {
    // Add to largest chapter
    distribution.sort((a, b) => b.chunks.length - a.chunks.length)[0].targetQuestions++;
    currentTotal++;
  }
  while (currentTotal > totalQuestions) {
    // Remove from smallest chapter (if it has more than 1)
    const smallest = distribution.sort((a, b) => a.chunks.length - b.chunks.length).find(d => d.targetQuestions > 1);
    if (smallest) {
      smallest.targetQuestions--;
      currentTotal--;
    } else {
      break;
    }
  }

  return distribution;
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
  const actualClusters = Math.min(numClusters, Math.ceil(chunks.length / MIN_CHUNKS_PER_GROUP));
  
  if (actualClusters <= 1) {
    return [{ chunks, centroid: null }];
  }

  console.log(`[TopicCluster] Clustering ${chunks.length} chunks into ${actualClusters} clusters`);

  // Filter chunks with valid embeddings - handle both array and JSON string formats
  const validChunks = chunks.filter(c => {
    if (!c.embedding) return false;
    if (Array.isArray(c.embedding)) return true;
    // Try to parse if it's a string (PostgreSQL sometimes returns JSON as string)
    if (typeof c.embedding === 'string') {
      try {
        const parsed = JSON.parse(c.embedding);
        if (Array.isArray(parsed)) {
          c.embedding = parsed; // Replace string with parsed array
          return true;
        }
      } catch (e) {
        return false;
      }
    }
    return false;
  });
  
  if (validChunks.length === 0) {
    console.warn('[TopicCluster] No chunks with valid embeddings, using all chunks in single cluster');
    return [{ chunks, centroid: null }];
  }

  console.log(`[TopicCluster] Found ${validChunks.length} chunks with valid embeddings`);

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
 * Generate questions for a single cluster with retry logic
 */
const generateQuestionsForCluster = async (cluster, options) => {
  const {
    count,
    questionType,
    difficulty,
    clusterIndex,
    totalClusters,
    chapterInfo = null
  } = options;

  // Filter chunks first
  let contentChunks = filterContentChunks(cluster.chunks);

  // Sort by similarity to centroid to find the most representative chunks for this topic
  if (cluster.centroid && contentChunks.length > 0) {
    contentChunks.sort((a, b) => {
      const simA = cosineSimilarity(a.embedding, cluster.centroid);
      const simB = cosineSimilarity(b.embedding, cluster.centroid);
      return simB - simA; // Descending similarity
    });
  }

  // Take diverse chunks - top relevant + some variety from the rest
  const topChunks = contentChunks.slice(0, 5);
  const remainingChunks = contentChunks.slice(5);
  // Shuffle remaining and take a few for variety
  const shuffled = remainingChunks.sort(() => Math.random() - 0.5);
  const varietyChunks = shuffled.slice(0, 3);
  contentChunks = [...topChunks, ...varietyChunks];
  
  if (contentChunks.length === 0) {
    const label = chapterInfo ? `Chapter ${chapterInfo.number}` : `Cluster ${clusterIndex + 1}`;
    console.log(`[${label}] No valid content chunks, skipping`);
    return { questions: [], error: 'No valid content chunks' };
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
    totalClusters,
    chapterInfo
  });

  const label = chapterInfo ? `Ch${chapterInfo.number}: ${chapterInfo.title}` : `Cluster ${clusterIndex + 1}/${totalClusters}`;
  console.log(`[${label}] Generating ${count} questions from ${contentChunks.length} chunks`);

  // Retry logic
  const maxRetries = 2;
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        console.log(`[Cluster ${clusterIndex + 1}] Retry attempt ${attempt}/${maxRetries}`);
        // Exponential backoff
        await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt - 1)));
      }

      // Call LLM with JSON mode enabled
      const response = await callLLM(context, prompt, { jsonMode: true });

      if (!response || typeof response !== 'string') {
        throw new Error('Empty or invalid LLM response');
      }

      // Parse questions from response - try multiple extraction methods
      let jsonMatch = response.match(/\[[\s\S]*\]/);
      
      // If no JSON array found, try to extract from markdown code blocks
      if (!jsonMatch) {
        const codeBlockMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (codeBlockMatch) {
          const codeContent = codeBlockMatch[1].trim();
          if (codeContent.startsWith('[')) {
            jsonMatch = [codeContent];
          }
        }
      }
      
      // If still no match, check if the entire response is a JSON array
      if (!jsonMatch) {
        const trimmed = response.trim();
        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
          jsonMatch = [trimmed];
        }
      }
      
      if (!jsonMatch) {
        // Log a preview of what the LLM actually returned for debugging
        console.warn(`[Cluster ${clusterIndex + 1}] No JSON array found in response. Preview: ${response.substring(0, 500)}...`);
        throw new Error('No JSON array in LLM response');
      }

      let questions;
      try {
        questions = JSON.parse(jsonMatch[0]);
      } catch (parseError) {
        console.warn(`[Cluster ${clusterIndex + 1}] JSON parse error: ${parseError.message}`);
        throw new Error(`JSON parse failed: ${parseError.message}`);
      }

      if (!Array.isArray(questions)) {
        throw new Error('Parsed response is not an array');
      }

      // Validate and normalize questions
      const validQuestions = questions
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

      if (validQuestions.length === 0) {
        console.warn(`[Cluster ${clusterIndex + 1}] Generated 0 valid questions. Raw response preview: ${response.substring(0, 200)}...`);
        throw new Error('LLM returned no valid questions');
      }

      console.log(`[Cluster ${clusterIndex + 1}] Successfully generated ${validQuestions.length} valid questions`);
      return { questions: validQuestions, error: null };

    } catch (error) {
      lastError = error;
      console.error(`[Cluster ${clusterIndex + 1}] Attempt ${attempt + 1} failed:`, error.message);
      
      // Don't retry on certain errors
      if (error.message?.includes('API key') || error.message?.includes('not configured')) {
        break;
      }
    }
  }

  console.error(`[Cluster ${clusterIndex + 1}] All attempts failed. Last error:`, lastError?.message);
  return { questions: [], error: lastError?.message || 'Unknown error' };
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
    totalClusters,
    chapterInfo = null
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

  // Chapter-aware context or topic cluster context
  let contextGuide;
  if (chapterInfo) {
    contextGuide = `\nYou are generating questions from Chapter ${chapterInfo.number}: "${chapterInfo.title}".
Focus on the key concepts, definitions, and ideas from this chapter.
Ensure questions test understanding of this chapter's material specifically.`;
  } else if (totalClusters > 1) {
    contextGuide = `\nYou are generating questions for topic area ${clusterIndex + 1} of ${totalClusters}. Focus on the specific concepts in this content section.`;
  } else {
    contextGuide = '';
  }

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
${contextGuide}

CRITICAL OUTPUT FORMAT REQUIREMENT:
- You MUST respond with ONLY a valid JSON array
- Do NOT include any text before or after the JSON array
- Do NOT use markdown code blocks
- Start your response with [ and end with ]

STRICT PROHIBITION (Zero Tolerance):
- ABSOLUTELY NO references to "the text", "the passage", "the document", "the author", "as mentioned in", etc.
- Questions MUST be written as objective facts about the world/subject, NEVER as reading comprehension questions about a specific text snippet.
- BAD: "According to the text, what is archaeology?"
- GOOD: "What is archaeology?"
- BAD: "The passage describes which process?"
- GOOD: "Which process involves...?"

Write questions as if you are a subject matter expert testing knowledge, NOT as if you are testing reading comprehension of a document.

${difficultyGuide}
${mathGuide}

Requirements:
1. Test conceptual understanding, not memorization of document structure
2. Questions should be educational and meaningful
3. Each question should cover a DIFFERENT concept from the content

${formatGuide}

REMEMBER: 
1. Respond with ONLY the JSON array. No other text.
2. NO references to the source text in question stems. Check every question before outputting.`;
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
 * Generate a quiz with balanced chapter coverage
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
  console.log(`[QuizGen] Starting chapter-balanced quiz generation`);
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

  // 3. Try to group chunks by chapter
  const chapterGroups = groupChunksByChapter(allChunks);
  
  let generationGroups;
  let useChapterMode = false;

  if (chapterGroups && chapterGroups.length > 1) {
    // Chapter structure detected - use proportional distribution
    useChapterMode = true;
    generationGroups = calculateChapterDistribution(chapterGroups, questionCount);
    console.log(`[QuizGen] Using CHAPTER-BASED distribution across ${generationGroups.length} chapters:`);
    generationGroups.forEach(g => {
      console.log(`  - ${g.chapterTitle}: ${g.targetQuestions} questions (${g.proportion} of content)`);
    });
  } else {
    // No chapter structure - fall back to topic clustering
    console.log(`[QuizGen] No chapter structure detected, using topic clustering`);
    const numClusters = Math.min(10, Math.ceil(allChunks.length / MIN_CHUNKS_PER_GROUP));
    const clusters = clusterChunksByTopic(allChunks, numClusters);
    
    const bufferMultiplier = 1.3;
    const targetPerCluster = Math.ceil((questionCount * bufferMultiplier) / clusters.length);
    
    generationGroups = clusters.map((cluster, i) => ({
      chapterNum: i + 1,
      chapterTitle: `Topic ${i + 1}`,
      chunks: cluster.chunks,
      centroid: cluster.centroid,
      targetQuestions: targetPerCluster
    }));
  }

  // 4. Generate questions for each group
  const startTime = Date.now();
  const bufferMultiplier = useChapterMode ? 1.5 : 1.3; // Generate more buffer for chapter mode
  
  const results = await runInBatches(generationGroups, CONCURRENCY_LIMIT, (group, index) => 
    generateQuestionsForCluster(
      { chunks: group.chunks, centroid: group.centroid || null },
      {
        count: Math.ceil(group.targetQuestions * bufferMultiplier),
        questionType,
        difficulty,
        clusterIndex: index,
        totalClusters: generationGroups.length,
        chapterInfo: useChapterMode ? { number: group.chapterNum, title: group.chapterTitle } : null
      }
    )
  );

  const generationTime = Date.now() - startTime;
  console.log(`[QuizGen] Generation completed in ${generationTime}ms`);

  // 5. Collect questions, respecting per-chapter targets
  const allQuestions = [];
  const errors = [];
  
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const group = generationGroups[i];
    
    if (result.questions && result.questions.length > 0) {
      // Take up to the target for this chapter (plus a small buffer)
      const questionsFromGroup = result.questions.slice(0, group.targetQuestions + 2);
      // Tag questions with chapter info
      questionsFromGroup.forEach(q => {
        q.chapter = group.chapterNum;
        q.chapterTitle = group.chapterTitle;
      });
      allQuestions.push(...questionsFromGroup);
    }
    if (result.error) {
      errors.push(result.error);
    }
  }
  
  for (const result of results) {
    if (result.questions && result.questions.length > 0) {
      allQuestions.push(...result.questions);
    }
    if (result.error) {
      errors.push(result.error);
    }
  }
  
  console.log(`[QuizGen] Generated ${allQuestions.length} total questions from ${clusters.length} clusters`);
  
  if (errors.length > 0) {
    console.log(`[QuizGen] Errors encountered: ${errors.length} clusters failed`);
    console.log(`[QuizGen] Error details: ${[...new Set(errors)].join('; ')}`);
  }

  if (allQuestions.length === 0) {
    // Provide detailed error message
    const uniqueErrors = [...new Set(errors)];
    let errorMessage = 'No questions generated (internal check).';
    
    if (uniqueErrors.length > 0) {
      if (uniqueErrors.some(e => e?.includes('API key') || e?.includes('not configured'))) {
        errorMessage = 'LLM API is not configured. Please check server configuration.';
      } else if (uniqueErrors.some(e => e?.includes('rate') || e?.includes('limit'))) {
        errorMessage = 'LLM API rate limit exceeded. Please try again in a few minutes.';
      } else if (uniqueErrors.some(e => e?.includes('JSON'))) {
        errorMessage = 'Failed to parse LLM responses. Please try again.';
      } else {
        errorMessage = `Generation Failed: ${uniqueErrors[0]}. Please try selecting fewer materials.`;
      }
    } else {
      errorMessage = 'LLM Generation Failed: No valid questions were produced. Please try again with different content.';
    }
    
    throw new Error(errorMessage);
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
 * Generate flashcards with balanced chapter coverage
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
  console.log(`[FlashcardGen] Starting chapter-balanced flashcard generation`);
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

  // 3. Try to group by chapter, fall back to topic clustering
  const chapterGroups = groupChunksByChapter(allChunks);
  
  let generationGroups;
  let useChapterMode = false;

  if (chapterGroups && chapterGroups.length > 1) {
    useChapterMode = true;
    generationGroups = calculateChapterDistribution(chapterGroups, count);
    console.log(`[FlashcardGen] Using CHAPTER-BASED distribution across ${generationGroups.length} chapters`);
  } else {
    console.log(`[FlashcardGen] No chapter structure, using topic clustering`);
    const numClusters = Math.min(10, Math.ceil(allChunks.length / MIN_CHUNKS_PER_GROUP));
    const clusters = clusterChunksByTopic(allChunks, numClusters);
    
    const bufferMultiplier = 1.3;
    const targetPerCluster = Math.ceil((count * bufferMultiplier) / clusters.length);
    
    generationGroups = clusters.map((cluster, i) => ({
      chapterNum: i + 1,
      chapterTitle: `Topic ${i + 1}`,
      chunks: cluster.chunks,
      centroid: cluster.centroid,
      targetQuestions: targetPerCluster
    }));
  }

  // 4. Generate flashcards for each group
  const startTime = Date.now();
  const bufferMultiplier = useChapterMode ? 1.5 : 1.3;
  
  const results = await runInBatches(generationGroups, CONCURRENCY_LIMIT, (group, index) => 
    generateQuestionsForCluster(
      { chunks: group.chunks, centroid: group.centroid || null },
      {
        count: Math.ceil(group.targetQuestions * bufferMultiplier),
        questionType: 'flashcard',
        difficulty: 'medium',
        clusterIndex: index,
        totalClusters: generationGroups.length,
        chapterInfo: useChapterMode ? { number: group.chapterNum, title: group.chapterTitle } : null
      }
    )
  );

  const generationTime = Date.now() - startTime;

  // 5. Collect flashcards, respecting per-chapter targets
  const allFlashcards = [];
  const errors = [];
  
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const group = generationGroups[i];
    
    if (result.questions && result.questions.length > 0) {
      const cardsFromGroup = result.questions.slice(0, group.targetQuestions + 2);
      cardsFromGroup.forEach(c => {
        c.chapter = group.chapterNum;
        c.chapterTitle = group.chapterTitle;
      });
      allFlashcards.push(...cardsFromGroup);
    }
    if (result.error) {
      errors.push(result.error);
    }
  }
  
  if (errors.length > 0) {
    console.log(`[FlashcardGen] Errors encountered: ${errors.length} groups failed`);
    console.log(`[FlashcardGen] Error details: ${[...new Set(errors)].join('; ')}`);
  }

  if (allFlashcards.length === 0) {
    const uniqueErrors = [...new Set(errors)];
    let errorMessage = 'No flashcards generated (internal check).';
    
    if (uniqueErrors.length > 0) {
      if (uniqueErrors.some(e => e?.includes('API key') || e?.includes('not configured'))) {
        errorMessage = 'LLM API is not configured. Please check server configuration.';
      } else if (uniqueErrors.some(e => e?.includes('rate') || e?.includes('limit'))) {
        errorMessage = 'LLM API rate limit exceeded. Please try again in a few minutes.';
      } else if (uniqueErrors.some(e => e?.includes('JSON'))) {
        errorMessage = 'Failed to parse LLM responses. Please try again.';
      } else {
        errorMessage = `Generation Failed: ${uniqueErrors[0]}. Please try selecting fewer materials.`;
      }
    } else {
      errorMessage = 'LLM Generation Failed: No valid flashcards were produced. Please try again with different content.';
    }
    
    throw new Error(errorMessage);
  }

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
