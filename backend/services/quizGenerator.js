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
import { Worker } from 'worker_threads';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKER_PATH = path.resolve(__dirname, '../workers/clusterWorker.js');

// Configuration
const CONCURRENCY_LIMIT = 20; // Increased from 8 to speed up generation
const MIN_CHUNKS_PER_GROUP = 1;
const DEDUP_SIMILARITY_THRESHOLD = 0.85;
const DEFAULT_CLUSTER_COUNT = 6;

/**
 * Run tasks in batches to respect rate limits
 */
const runInBatches = async (items, batchSize, fn, onProgress) => {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    if (onProgress) {
        onProgress(`Processing batch ${Math.floor(i / batchSize) + 1} of ${Math.ceil(items.length / batchSize)}`);
    }
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
      AND LENGTH(mc.content) > 20
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
    
    if (chapterNum && chapterTitle !== 'Main Content') {
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
    // If half or more chunks have no chapter, use topic clustering instead
    // Lowered threshold from 0.7 to 0.5 to be more aggressive about clustering unstructured content
    if (noChapter.length >= chunks.length * 0.5) {
      console.log(`[Group] ${noChapter.length}/${chunks.length} chunks are unstructured. Falling back to topic clustering.`);
      return null;
    }
    groups.push({
      chapterNum: 0,
      chapterTitle: 'General Content',
      materialId: null,
      chunks: noChapter
    });
  }

  // Check for dominant chapter (e.g. one chapter has > 60% content)
  // This indicates a likely false positive or a single-chapter document where clustering is better
  const totalChunks = chunks.length;
  if (groups.some(g => g.chunks.length > totalChunks * 0.6)) {
     console.log(`[Group] Dominant chapter detected (>60% content). Falling back to topic clustering.`);
     return null;
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
 * Cluster chunks by topic using k-means on embeddings
 * Offloaded to a worker thread to prevent blocking the event loop
 */
const clusterChunksByTopic = (chunks, numClusters = DEFAULT_CLUSTER_COUNT) => {
  return new Promise((resolve, reject) => {
    // Run clustering in a separate worker thread
    const worker = new Worker(WORKER_PATH);
    
    worker.on('message', (message) => {
      if (message.success) {
        resolve(message.result);
      } else {
        reject(new Error(message.error));
      }
      worker.terminate();
    });

    worker.on('error', (error) => {
      console.error('[TopicCluster] Worker error:', error);
      reject(error);
      worker.terminate();
    });

    worker.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`Worker stopped with exit code ${code}`));
      }
    });

    worker.postMessage({
      chunks,
      numClusters,
      minChunksPerGroup: MIN_CHUNKS_PER_GROUP
    });
  });
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
    // Reduced minimum from 100 to 50 chars to allow smaller content chunks
    const isTooShort = content.length < 50;

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

  // Filter chunks first, but fall back to original if filtering removes everything
  let contentChunks = filterContentChunks(cluster.chunks);
  
  // Fallback: if filtering removed all chunks, use original chunks
  if (contentChunks.length === 0 && cluster.chunks.length > 0) {
    console.log(`[Cluster ${clusterIndex + 1}] Filtering removed all chunks, using original ${cluster.chunks.length} chunks`);
    contentChunks = cluster.chunks.filter(c => c.content && c.content.length > 0);
  }

  // Sort by similarity to centroid to find the most representative chunks for this topic
  if (cluster.centroid && contentChunks.length > 0) {
    contentChunks.sort((a, b) => {
      const simA = cosineSimilarity(a.embedding, cluster.centroid);
      const simB = cosineSimilarity(b.embedding, cluster.centroid);
      return simB - simA; // Descending similarity
    });
  }

  // Take diverse chunks - top relevant + some variety from the rest
  // Strategy: To support multiple calls for the same cluster, we add randomness to top selection
  
  // Determine pool of "top" chunks (e.g., top 8 or all if fewer)
  const topPoolSize = Math.min(contentChunks.length, 8);
  const topPool = contentChunks.slice(0, topPoolSize);
  
  // Shuffle top pool and take 3
  const selectedTop = topPool.sort(() => Math.random() - 0.5).slice(0, 3);
  
  // Remaining chunks for variety (exclude those already picked)
  const selectedIds = new Set(selectedTop.map(c => c.id));
  const remainingPool = contentChunks.filter(c => !selectedIds.has(c.id));
  
  // Shuffle remaining and take 2
  const selectedVariety = remainingPool.sort(() => Math.random() - 0.5).slice(0, 2);
  
  contentChunks = [...selectedTop, ...selectedVariety];
  
  if (contentChunks.length === 0) {
    const label = chapterInfo ? `Chapter ${chapterInfo.number}` : `Cluster ${clusterIndex + 1}`;
    console.log(`[${label}] No valid content chunks available, skipping`);
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
  }, context);

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
      // Pass empty string for text, prompt contains the context to avoid default "Content:" wrapping
      const response = await callLLM('', prompt, { jsonMode: true });

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
      
      // Handle truncated responses - if starts with [ but no closing ], try to fix it
      if (!jsonMatch) {
        const trimmed = response.trim();
        if (trimmed.startsWith('[')) {
          // Try to find the last complete object and close the array
          const lastCompleteObject = trimmed.lastIndexOf('}');
          if (lastCompleteObject > 0) {
            const fixedJson = trimmed.substring(0, lastCompleteObject + 1) + ']';
            console.log(`[Cluster ${clusterIndex + 1}] Attempting to fix truncated JSON response`);
            jsonMatch = [fixedJson];
          }
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
          options: questionType === 'multiple_choice' ? (q.options || null) : null,
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
const buildQuestionPrompt = (options, contextContent) => {
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
    contextGuide = `\nSOURCE MATERIAL CONTEXT:\nYou are generating questions from Chapter ${chapterInfo.number}: "${chapterInfo.title}".`;
  } else if (totalClusters > 1) {
    contextGuide = `\nSOURCE MATERIAL CONTEXT:\nYou are generating questions for topic area ${clusterIndex + 1} of ${totalClusters}.`;
  } else {
    contextGuide = '\nSOURCE MATERIAL CONTEXT:\nUse the provided content as the source of facts.';
  }

  let formatGuide;
  if (questionType === 'multiple_choice') {
    formatGuide = `Generate exactly ${count} multiple-choice questions.
Each question must have:
- A clear question asking about a fact or concept
- 4 options (A, B, C, D)
- One correct answer
- A brief explanation

JSON format:
[
  {
    "question": "What is the primary function of mitochondria?",
    "options": {"A": "Energy production", "B": "Protein synthesis", "C": "Waste removal", "D": "Cell division"},
    "correct_answer": "A",
    "explanation": "Mitochondria are known as the powerhouse of the cell because they generate most of the cell's supply of adenosine triphosphate (ATP).",
    "difficulty": "medium",
    "topic": "Cell Biology"
  }
]`;
  } else if (questionType === 'true_false') {
    formatGuide = `Generate exactly ${count} true/false questions.
Each question must be a DECLARATIVE STATEMENT.
- Do NOT ask a question (e.g. "Is the sky blue?").
- Do NOT provide options (A, B, C, D).
- State a fact that is either clearly true or clearly false.
- Provide the correct answer ("true" or "false").
- Provide a brief explanation.

JSON format:
[
  {
    "question": "Mitochondria are responsible for protein synthesis.",
    "correct_answer": "false",
    "explanation": "Ribosomes are responsible for protein synthesis, while mitochondria generate energy.",
    "difficulty": "medium"
  }
]`;
  } else if (questionType === 'flashcard') {
    formatGuide = `Generate exactly ${count} flashcards.
Each flashcard must have:
- A front (concept, term, or question)
- A back (definition, answer, or explanation)

JSON format:
[
  {
    "front": "Mitochondria",
    "back": "Organelle that generates most of the chemical energy needed to power the cell's biochemical reactions (ATP).",
    "topic": "Cell Biology"
  }
]`;
  } else {
    formatGuide = `Generate exactly ${count} short-answer questions.
Each question must have:
- A clear direct question
- A model answer
- Key points

JSON format:
[
  {
    "question": "How do mitochondria generate energy?",
    "model_answer": "Mitochondria generate energy through oxidative phosphorylation...",
    "key_points": ["oxidative phosphorylation", "ATP production", "inner membrane"],
    "difficulty": "medium"
  }
]`;
  }

  return `You are an expert educator creating a high-quality quiz.
${contextGuide}

SOURCE CONTENT:
"""
${contextContent}
"""

INSTRUCTIONS:
1. Extract key facts, concepts, and relationships from the SOURCE CONTENT above.
2. Create ${count} ${questionType} questions based on these facts.

CRITICAL RULES (VIOLATION = FAILURE):
1. QUESTIONS MUST BE STANDALONE. They must make sense to someone who has never seen the source text but knows the subject.
2. NEVER reference the text/passage/author in the question or answer.
   - ❌ BAD: "According to the text, what is..."
   - ❌ BAD: "The author argues that..."
   - ❌ BAD: "As mentioned in the passage..."
   - ✅ GOOD: "What is..."
   - ✅ GOOD: "Which factor contributes to..."
   - ✅ GOOD: "True or False: X causes Y."
3. Test CONCEPTS and KNOWLEDGE, not reading comprehension.
   - ❌ BAD: "What does the second paragraph say about X?"
   - ✅ GOOD: "How does X affect Y?"

${difficultyGuide}
${mathGuide}

${formatGuide}

RESPONSE FORMAT:
Respond with ONLY the valid JSON array. No other text.`;
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
export const generateQuizFromSections = async (options, onProgress) => {
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

  if (onProgress) onProgress("Starting quiz generation...");

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
  if (onProgress) onProgress("Fetching study materials...");
  const materialIds = await getMaterialIdsFromSections(sectionIds);
  console.log(`[QuizGen] Found ${materialIds.length} materials from ${sectionIds.length} sections`);

  if (materialIds.length === 0) {
    throw new Error('No processed materials found in the selected sections. Please ensure files have been uploaded and processed.');
  }

  // 2. Get all chunks for materials
  if (onProgress) onProgress("Processing document content...");
  const allChunks = await getAllChunksForMaterials(materialIds);
  console.log(`[QuizGen] Retrieved ${allChunks.length} chunks with embeddings`);

  if (allChunks.length === 0) {
    throw new Error('No content chunks found in the selected materials.');
  }

  // 3. Try to group chunks by chapter
  if (onProgress) onProgress("Analyzing topics and chapters...");
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
    // No chapter structure - use CONTENT-BASED topic clustering
    // Cluster count is based on content size, NOT quiz size
    // Aim for ~20-30 chunks per cluster for meaningful topic groupings
    console.log(`[QuizGen] No chapter structure detected, using content-based topic clustering`);
    
    const CHUNKS_PER_TOPIC = 25; // Target chunks per topic cluster
    const contentBasedClusters = Math.ceil(allChunks.length / CHUNKS_PER_TOPIC);
    // Ensure reasonable bounds: min 2 clusters, max 12 clusters
    const numClusters = Math.max(2, Math.min(12, contentBasedClusters));
    
    console.log(`[QuizGen] Content has ${allChunks.length} chunks -> ${numClusters} topic clusters`);
    
    const clusters = await clusterChunksByTopic(allChunks, numClusters);
    
    // Distribute questions proportionally across clusters based on cluster size
    // This ensures good coverage even for small quizzes
    const totalClusterChunks = clusters.reduce((sum, c) => sum + c.chunks.length, 0);
    
    generationGroups = clusters.map((cluster, i) => {
      // Proportional distribution based on cluster content size
      const proportion = cluster.chunks.length / totalClusterChunks;
      const rawTarget = Math.round(questionCount * proportion);
      // Ensure at least 1 question per cluster for coverage (if quiz size allows)
      const minPerCluster = questionCount >= clusters.length ? 1 : 0;
      const targetQuestions = Math.max(minPerCluster, rawTarget);
      
      return {
        chapterNum: i + 1,
        chapterTitle: `Topic ${i + 1}`,
        chunks: cluster.chunks,
        centroid: cluster.centroid,
        targetQuestions,
        proportion: (proportion * 100).toFixed(1) + '%'
      };
    });
    
    // Filter out clusters with 0 questions (for very small quizzes)
    generationGroups = generationGroups.filter(g => g.targetQuestions > 0);
    
    // Adjust totals to match requested count
    let currentTotal = generationGroups.reduce((sum, g) => sum + g.targetQuestions, 0);
    while (currentTotal < questionCount && generationGroups.length > 0) {
      // Add to largest cluster
      generationGroups.sort((a, b) => b.chunks.length - a.chunks.length)[0].targetQuestions++;
      currentTotal++;
    }
    while (currentTotal > questionCount && generationGroups.length > 0) {
      // Remove from cluster with most questions (if > 1)
      const largest = generationGroups.sort((a, b) => b.targetQuestions - a.targetQuestions).find(g => g.targetQuestions > 1);
      if (largest) {
        largest.targetQuestions--;
        currentTotal--;
      } else {
        break;
      }
    }
    
    console.log(`[QuizGen] Topic distribution for ${questionCount} questions across ${generationGroups.length} topics:`);
    generationGroups.forEach(g => {
      console.log(`  - ${g.chapterTitle}: ${g.targetQuestions} questions (${g.proportion} of content)`);
    });
  }

  // 4. Generate questions for each group
  const startTime = Date.now();
  // Small buffer to ensure we get enough questions after deduplication
  const bufferMultiplier = 1.15;
  
  // Cap questions per LLM call to avoid truncated responses
  const MAX_QUESTIONS_PER_CALL = 20;
  
  // Break down groups into smaller tasks if they exceed MAX_QUESTIONS_PER_CALL
  const tasks = [];
  
  generationGroups.forEach((group, groupIndex) => {
    const targetWithBuffer = Math.ceil(group.targetQuestions * bufferMultiplier);
    let remaining = targetWithBuffer;
    
    // Ensure at least one task even if target is small
    if (remaining === 0) remaining = 1;

    while (remaining > 0) {
      const count = Math.min(MAX_QUESTIONS_PER_CALL, remaining);
      tasks.push({
        group,
        groupIndex,
        count
      });
      remaining -= count;
    }
  });

  console.log(`[QuizGen] Created ${tasks.length} generation tasks for ${generationGroups.length} groups`);

  if (onProgress) onProgress("Generating questions with AI...");
  const results = await runInBatches(tasks, CONCURRENCY_LIMIT, (task, index) => 
    generateQuestionsForCluster(
      { chunks: task.group.chunks, centroid: task.group.centroid || null },
      {
        count: task.count,
        questionType,
        difficulty,
        clusterIndex: task.groupIndex,
        totalClusters: generationGroups.length,
        chapterInfo: useChapterMode ? { number: task.group.chapterNum, title: task.group.chapterTitle } : null
      }
    ),
    (msg) => {
       if (onProgress) onProgress(`Generating questions: ${msg}`);
    }
  );

  const generationTime = Date.now() - startTime;
  console.log(`[QuizGen] Generation completed in ${generationTime}ms`);

  // 5. Collect questions, respecting per-chapter targets
  if (onProgress) onProgress("Processing generated questions...");
  const allQuestions = [];
  const errors = [];
  
  // Group results back to their chapters/clusters
  const questionsByGroup = new Map();
  
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const task = tasks[i];
    const group = task.group;
    
    if (result.questions && result.questions.length > 0) {
      if (!questionsByGroup.has(group)) {
        questionsByGroup.set(group, []);
      }
      questionsByGroup.get(group).push(...result.questions);
    }
    if (result.error) {
      errors.push(result.error);
    }
  }

  // Process grouped questions
  generationGroups.forEach(group => {
    const questions = questionsByGroup.get(group) || [];
    
    // Take up to the target for this chapter (plus a small buffer)
    const cap = group.targetQuestions + 2; 
    const kept = questions.slice(0, cap);
    
    kept.forEach(q => {
      q.chapter = group.chapterNum;
      q.chapterTitle = group.chapterTitle;
    });
    
    allQuestions.push(...kept);
  });
  
  console.log(`[QuizGen] Generated ${allQuestions.length} total questions from ${generationGroups.length} groups`);
  
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
  if (onProgress) onProgress("Deduplicating questions...");
  const uniqueQuestions = await deduplicateQuestions(allQuestions);

  // 9. Take only the requested count
  const finalQuestions = uniqueQuestions.slice(0, questionCount);
  console.log(`[QuizGen] Final quiz: ${finalQuestions.length} questions`);

  // 10. Store quiz in database
  if (onProgress) onProgress("Saving quiz...");
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
      clustersUsed: generationGroups.length,
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

  // Added explicit null check as groupChunksByChapter returns null for clustering fallback
  if (chapterGroups && chapterGroups.length > 1) {
    useChapterMode = true;
    generationGroups = calculateChapterDistribution(chapterGroups, count);
    console.log(`[FlashcardGen] Using CHAPTER-BASED distribution across ${generationGroups.length} chapters`);
  } else {
    console.log(`[FlashcardGen] No chapter structure, using topic clustering`);
    const numClusters = Math.min(10, Math.ceil(allChunks.length / MIN_CHUNKS_PER_GROUP));
    const clusters = await clusterChunksByTopic(allChunks, numClusters);
    
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
  
  // Break down groups into smaller tasks
  const tasks = [];
  
  generationGroups.forEach((group, groupIndex) => {
    const targetWithBuffer = Math.ceil(group.targetQuestions * bufferMultiplier);
    let remaining = targetWithBuffer;
    
    if (remaining === 0) remaining = 1;

    while (remaining > 0) {
      const count = Math.min(MAX_QUESTIONS_PER_CALL, remaining);
      tasks.push({
        group,
        groupIndex,
        count
      });
      remaining -= count;
    }
  });
  
  console.log(`[FlashcardGen] Created ${tasks.length} generation tasks for ${generationGroups.length} groups`);

  const results = await runInBatches(tasks, CONCURRENCY_LIMIT, (task, index) => 
    generateQuestionsForCluster(
      { chunks: task.group.chunks, centroid: task.group.centroid || null },
      {
        count: task.count,
        questionType: 'flashcard',
        difficulty: 'medium',
        clusterIndex: task.groupIndex,
        totalClusters: generationGroups.length,
        chapterInfo: useChapterMode ? { number: task.group.chapterNum, title: task.group.chapterTitle } : null
      }
    )
  );

  const generationTime = Date.now() - startTime;

  // 5. Collect flashcards, respecting per-chapter targets
  const allFlashcards = [];
  const errors = [];
  
  const cardsByGroup = new Map();
  
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const task = tasks[i];
    const group = task.group;
    
    if (result.questions && result.questions.length > 0) {
      if (!cardsByGroup.has(group)) {
        cardsByGroup.set(group, []);
      }
      cardsByGroup.get(group).push(...result.questions);
    }
    if (result.error) {
      errors.push(result.error);
    }
  }
  
  generationGroups.forEach(group => {
    const cards = cardsByGroup.get(group) || [];
    const cap = group.targetQuestions + 2;
    const kept = cards.slice(0, cap);
    
    kept.forEach(c => {
      c.chapter = group.chapterNum;
      c.chapterTitle = group.chapterTitle;
    });
    allFlashcards.push(...kept);
  });
  
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

      const qResult = await client.query(
        `INSERT INTO questions 
         (quiz_set_id, question_index, question, question_type, options, correct_answer, 
          explanation, difficulty, topic, chapter, source_chunk_ids)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING id`,
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
      
      // Assign the generated ID back to the question object so it's returned to frontend
      q.id = qResult.rows[0].id;
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
      const cardResult = await client.query(
        `INSERT INTO flashcards (flashcard_set_id, front, back, topic, chapter)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [setId, card.front || card.question, card.back || card.explanation, card.topic, card.chapter]
      );
      
      card.id = cardResult.rows[0].id;
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
