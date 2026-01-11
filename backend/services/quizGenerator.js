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
import { generateEmbedding, generateBatchEmbeddings, cosineSimilarity } from './embeddingService.js';
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
const MAX_QUESTIONS_PER_CALL = 20; // Cap questions per LLM call to avoid truncated responses

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
        .map(q => {
          // Normalize options for multiple choice questions
          let normalizedOptions = null;
          if (questionType === 'multiple_choice') {
            if (q.options && typeof q.options === 'object') {
              // Ensure options is an object with A, B, C, D keys
              normalizedOptions = {
                A: q.options.A || q.options.a || q.options['1'] || '',
                B: q.options.B || q.options.b || q.options['2'] || '',
                C: q.options.C || q.options.c || q.options['3'] || '',
                D: q.options.D || q.options.d || q.options['4'] || ''
              };
              // Validate that we have actual options
              const hasValidOptions = Object.values(normalizedOptions).some(v => v && v.trim());
              if (!hasValidOptions) {
                console.warn(`[Cluster ${clusterIndex + 1}] Question has empty options:`, q.question?.substring(0, 50));
                normalizedOptions = null;
              }
            } else if (Array.isArray(q.options) && q.options.length >= 4) {
              // Handle array format [option1, option2, option3, option4]
              normalizedOptions = {
                A: q.options[0] || '',
                B: q.options[1] || '',
                C: q.options[2] || '',
                D: q.options[3] || ''
              };
            }
          }

          // Normalize correct answer
          let correctAnswer = q.correct_answer || q.correctAnswer || null;
          if (questionType === 'true_false' && correctAnswer) {
            // Ensure true/false answers are lowercase
            correctAnswer = String(correctAnswer).toLowerCase();
            if (correctAnswer !== 'true' && correctAnswer !== 'false') {
              // Try to interpret the answer
              if (['yes', 't', '1'].includes(correctAnswer)) {
                correctAnswer = 'true';
              } else if (['no', 'f', '0'].includes(correctAnswer)) {
                correctAnswer = 'false';
              }
            }
          } else if (questionType === 'multiple_choice' && correctAnswer) {
            // Ensure correct answer is uppercase A, B, C, or D
            correctAnswer = String(correctAnswer).toUpperCase().trim();
            if (!['A', 'B', 'C', 'D'].includes(correctAnswer)) {
              console.warn(`[Cluster ${clusterIndex + 1}] Invalid correct answer "${correctAnswer}" for MC question`);
            }
          }

          return {
            question: q.question?.trim(),
            front: q.front?.trim(),
            back: q.back?.trim(),
            questionType: questionType,
            options: normalizedOptions,
            correctAnswer: correctAnswer,
            explanation: q.explanation || null,
            difficulty: q.difficulty || difficulty,
            topic: q.topic || null,
            chapter: q.chapter || null,
            sourceChunkIds: contentChunks.slice(0, 3).map(c => c.id),
            clusterIndex
          };
        })
        // Filter out multiple choice questions without valid options
        .filter(q => {
          if (q.questionType === 'multiple_choice' && !q.options) {
            console.warn(`[Cluster ${clusterIndex + 1}] Filtering out MC question without options:`, q.question?.substring(0, 50));
            return false;
          }
          return true;
        });

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

REQUIREMENTS FOR EACH QUESTION:
- A clear question asking about a specific fact, concept, or relationship
- EXACTLY 4 answer options labeled A, B, C, D
- Each option must be a distinct, plausible answer (no obviously wrong options)
- One and only one correct answer (A, B, C, or D)
- A brief explanation of why the correct answer is right

CRITICAL: You MUST include the "options" field as an object with keys "A", "B", "C", "D".

JSON format (follow EXACTLY):
[
  {
    "question": "What is the primary function of mitochondria in eukaryotic cells?",
    "options": {
      "A": "Energy production through ATP synthesis",
      "B": "Protein synthesis and folding",
      "C": "Waste removal and detoxification",
      "D": "Cell division and reproduction"
    },
    "correct_answer": "A",
    "explanation": "Mitochondria are known as the powerhouse of the cell because they generate most of the cell's ATP through oxidative phosphorylation.",
    "difficulty": "medium",
    "topic": "Cell Biology"
  },
  {
    "question": "Which process occurs in the inner mitochondrial membrane?",
    "options": {
      "A": "Glycolysis",
      "B": "Electron transport chain",
      "C": "DNA replication",
      "D": "Transcription"
    },
    "correct_answer": "B",
    "explanation": "The electron transport chain is located in the inner mitochondrial membrane where it generates the proton gradient used for ATP synthesis.",
    "difficulty": "hard",
    "topic": "Cell Biology"
  }
]`;
  } else if (questionType === 'true_false') {
    formatGuide = `Generate exactly ${count} true/false questions.

REQUIREMENTS FOR EACH QUESTION:
- The "question" field MUST be a DECLARATIVE STATEMENT (a sentence that states something as fact)
- Do NOT phrase as a question (no "Is...", "Does...", "Can...", etc.)
- Do NOT include options - only the statement
- The statement should be clearly true or clearly false based on the source material
- Include a mix of true and false statements (roughly 50/50)
- The "correct_answer" must be exactly "true" or "false" (lowercase)
- Include an explanation of why the statement is true or false

EXAMPLES OF GOOD STATEMENTS:
✅ "Mitochondria are responsible for protein synthesis." (false)
✅ "The electron transport chain occurs in the inner mitochondrial membrane." (true)
✅ "ATP is produced during glycolysis in the mitochondria." (false - glycolysis occurs in cytoplasm)

EXAMPLES OF BAD STATEMENTS:
❌ "Is the mitochondria responsible for energy production?" (this is a question, not a statement)
❌ "True or False: Mitochondria produce ATP" (don't include "True or False" prefix)

JSON format (follow EXACTLY):
[
  {
    "question": "Mitochondria are responsible for protein synthesis in cells.",
    "correct_answer": "false",
    "explanation": "Ribosomes are responsible for protein synthesis, while mitochondria are responsible for ATP production through cellular respiration.",
    "difficulty": "medium"
  },
  {
    "question": "The inner mitochondrial membrane contains the electron transport chain.",
    "correct_answer": "true",
    "explanation": "The electron transport chain is embedded in the inner mitochondrial membrane, where it creates a proton gradient for ATP synthesis.",
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
2. Create ${count} ${questionType.replace('_', ' ')} questions based on these facts.

CRITICAL RULES (VIOLATION = FAILURE):
1. QUESTIONS MUST BE STANDALONE. They must make sense to someone who has never seen the source text but knows the subject.
2. NEVER reference the text/passage/author in the question or answer.
   - ❌ BAD: "According to the text, what is..."
   - ❌ BAD: "The author argues that..."
   - ❌ BAD: "As mentioned in the passage..."
   - ✅ GOOD: "What is..."
   - ✅ GOOD: "Which factor contributes to..."
3. Test CONCEPTS and KNOWLEDGE, not reading comprehension.
   - ❌ BAD: "What does the second paragraph say about X?"
   - ✅ GOOD: "How does X affect Y?"

${difficultyGuide}
${mathGuide}

${formatGuide}

RESPONSE FORMAT:
Respond with ONLY the valid JSON array. No markdown code blocks, no explanatory text. Just the raw JSON array starting with [ and ending with ].`;
};

/**
 * Fast text-based similarity check (Jaccard on words)
 * Used as a quick pre-filter before expensive embedding comparison
 */
const textSimilarity = (text1, text2) => {
  const words1 = new Set(text1.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  const words2 = new Set(text2.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  
  const intersection = [...words1].filter(w => words2.has(w)).length;
  const union = new Set([...words1, ...words2]).size;
  
  return union > 0 ? intersection / union : 0;
};

/**
 * Deduplicate questions using embedding similarity
 * Optimized with batch embeddings and text pre-filtering
 */
const deduplicateQuestions = async (questions) => {
  if (questions.length <= 1) return questions;

  console.log(`[Dedup] Deduplicating ${questions.length} questions...`);
  const startTime = Date.now();

  // Quick text-based pre-filter for obvious duplicates
  const questionTexts = questions.map(q => q.question || q.front);
  const preFilteredIndices = new Set();
  
  for (let i = 0; i < questionTexts.length; i++) {
    if (preFilteredIndices.has(i)) continue;
    for (let j = i + 1; j < questionTexts.length; j++) {
      if (preFilteredIndices.has(j)) continue;
      // If text similarity is very high, mark as duplicate without embedding
      if (textSimilarity(questionTexts[i], questionTexts[j]) > 0.8) {
        preFilteredIndices.add(j);
      }
    }
  }
  
  // Get indices of questions that passed pre-filter
  const candidateIndices = [];
  for (let i = 0; i < questions.length; i++) {
    if (!preFilteredIndices.has(i)) {
      candidateIndices.push(i);
    }
  }
  
  if (preFilteredIndices.size > 0) {
    console.log(`[Dedup] Pre-filter removed ${preFilteredIndices.size} obvious duplicates`);
  }
  
  // If few candidates remain, skip expensive embedding dedup
  if (candidateIndices.length <= 5) {
    console.log(`[Dedup] Skipping embedding dedup (only ${candidateIndices.length} candidates)`);
    return candidateIndices.map(i => {
      const { clusterIndex, ...q } = questions[i];
      return q;
    });
  }

  // Generate embeddings in batch (much faster than individual calls)
  const candidateTexts = candidateIndices.map(i => questionTexts[i]);
  const embeddingResults = await generateBatchEmbeddings(candidateTexts, { provider: 'openai' });
  
  // Map embeddings back to candidate indices
  const embeddings = {};
  embeddingResults.forEach((result, idx) => {
    embeddings[candidateIndices[idx]] = result.embedding;
  });

  const unique = [];

  for (const i of candidateIndices) {
    let isDuplicate = false;

    for (const uniqueQ of unique) {
      const similarity = cosineSimilarity(
        embeddings[i],
        embeddings[uniqueQ.originalIndex]
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

  const elapsed = Date.now() - startTime;
  console.log(`[Dedup] Kept ${unique.length} unique questions (removed ${questions.length - unique.length} duplicates) in ${elapsed}ms`);

  // Remove the originalIndex helper field
  return unique.map(({ originalIndex, clusterIndex, ...q }) => q);
};

/**
 * Generate a quiz with balanced chapter coverage
 * 
 * @param options.chapterFilter - Optional: Array of { materialId, chapters: number[] } to filter by specific chapters
 *                                Example: [{ materialId: 'uuid', chapters: [1, 3, 5] }]
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
    description = null,
    chapterFilter = null  // New: filter by specific chapters per material
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
  let allChunks = await getAllChunksForMaterials(materialIds);
  console.log(`[QuizGen] Retrieved ${allChunks.length} chunks with embeddings`);

  if (allChunks.length === 0) {
    throw new Error('No content chunks found in the selected materials.');
  }

  // 2.5. Apply chapter filter if provided
  if (chapterFilter && Array.isArray(chapterFilter) && chapterFilter.length > 0) {
    const filterMap = new Map();
    for (const filter of chapterFilter) {
      if (filter.materialId && Array.isArray(filter.chapters) && filter.chapters.length > 0) {
        filterMap.set(filter.materialId, new Set(filter.chapters));
      }
    }

    if (filterMap.size > 0) {
      const beforeCount = allChunks.length;
      allChunks = allChunks.filter(chunk => {
        const allowedChapters = filterMap.get(chunk.material_id);
        if (!allowedChapters) {
          // Material not in filter - include all its chunks if not filtered
          // Only filter if this material is explicitly in the filter list
          return !filterMap.has(chunk.material_id);
        }
        // Check if chunk's chapter is in the allowed list
        const chunkChapter = chunk.metadata?.chapter;
        return chunkChapter && allowedChapters.has(chunkChapter);
      });
      
      console.log(`[QuizGen] Chapter filter applied: ${beforeCount} → ${allChunks.length} chunks`);
      console.log(`[QuizGen] Filtering for chapters in ${filterMap.size} material(s)`);
      
      if (allChunks.length === 0) {
        throw new Error('No content chunks found for the selected chapters. Please select different chapters or materials.');
      }
    }
  }

  // 3. Try to group chunks by chapter
  if (onProgress) onProgress("Analyzing topics and chapters...");
  const chapterGroups = groupChunksByChapter(allChunks);
  
  let generationGroups;
  let useChapterMode = false;

  if (chapterGroups && chapterGroups.length > 1) {
    // Chapter structure detected - use two-level hierarchy: Chapter -> Topics within chapter
    useChapterMode = true;
    console.log(`[QuizGen] Detected ${chapterGroups.length} chapters, discovering topics within each...`);
    
    // First, calculate question distribution across chapters
    const chapterDistribution = calculateChapterDistribution(chapterGroups, questionCount);
    
    // Then, discover natural topics within each chapter
    generationGroups = [];
    
    for (const chapter of chapterDistribution) {
      if (chapter.chunks.length <= 3) {
        // Small chapter - treat as single topic
        generationGroups.push({
          ...chapter,
          topicLabel: `${chapter.chapterTitle}`,
          centroid: null
        });
      } else {
        // Discover natural topics within this chapter
        const chapterTopics = await clusterChunksByTopic(chapter.chunks);
        
        if (chapterTopics.length === 1) {
          // Chapter has one cohesive topic
          generationGroups.push({
            ...chapter,
            chunks: chapterTopics[0].chunks,
            centroid: chapterTopics[0].centroid,
            topicLabel: `${chapter.chapterTitle}`
          });
        } else {
          // Distribute chapter's questions across its topics proportionally
          const totalTopicChunks = chapterTopics.reduce((sum, t) => sum + t.chunks.length, 0);
          
          for (let t = 0; t < chapterTopics.length; t++) {
            const topic = chapterTopics[t];
            const proportion = topic.chunks.length / totalTopicChunks;
            const topicQuestions = Math.max(1, Math.round(chapter.targetQuestions * proportion));
            
            generationGroups.push({
              chapterNum: chapter.chapterNum,
              chapterTitle: chapter.chapterTitle,
              topicNum: t + 1,
              topicLabel: `${chapter.chapterTitle} - Topic ${t + 1}`,
              chunks: topic.chunks,
              centroid: topic.centroid,
              targetQuestions: topicQuestions,
              proportion: (proportion * 100).toFixed(1) + '%'
            });
          }
        }
      }
    }
    
    // Adjust totals to match requested count
    let currentTotal = generationGroups.reduce((sum, g) => sum + g.targetQuestions, 0);
    while (currentTotal < questionCount && generationGroups.length > 0) {
      generationGroups.sort((a, b) => b.chunks.length - a.chunks.length)[0].targetQuestions++;
      currentTotal++;
    }
    while (currentTotal > questionCount && generationGroups.length > 0) {
      const largest = generationGroups.sort((a, b) => b.targetQuestions - a.targetQuestions).find(g => g.targetQuestions > 1);
      if (largest) {
        largest.targetQuestions--;
        currentTotal--;
      } else {
        break;
      }
    }
    
    console.log(`[QuizGen] Using CHAPTER->TOPIC hierarchy with ${generationGroups.length} topic groups:`);
    generationGroups.forEach(g => {
      console.log(`  - ${g.topicLabel || g.chapterTitle}: ${g.targetQuestions} questions`);
    });
  } else {
    // No chapter structure - use hierarchical clustering to discover natural topics
    // The algorithm finds topic boundaries based on semantic similarity, not arbitrary numbers
    console.log(`[QuizGen] No chapter structure detected, discovering natural topic clusters`);
    
    // clusterChunksByTopic now uses hierarchical clustering to find natural topic boundaries
    const clusters = await clusterChunksByTopic(allChunks);
    
    console.log(`[QuizGen] Discovered ${clusters.length} natural topic clusters from ${allChunks.length} chunks`);
    
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
 * 
 * @param options.chapterFilter - Optional: Array of { materialId, chapters: number[] } to filter by specific chapters
 */
export const generateFlashcardsFromSections = async (options) => {
  const {
    sectionIds,
    userId,
    count = 20,
    topic = null,
    name = null,
    folderId = null,
    description = null,
    chapterFilter = null  // New: filter by specific chapters per material
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
  let allChunks = await getAllChunksForMaterials(materialIds);
  
  if (allChunks.length === 0) {
    throw new Error('No content chunks found in the selected materials.');
  }

  // 2.5. Apply chapter filter if provided
  if (chapterFilter && Array.isArray(chapterFilter) && chapterFilter.length > 0) {
    const filterMap = new Map();
    for (const filter of chapterFilter) {
      if (filter.materialId && Array.isArray(filter.chapters) && filter.chapters.length > 0) {
        filterMap.set(filter.materialId, new Set(filter.chapters));
      }
    }

    if (filterMap.size > 0) {
      const beforeCount = allChunks.length;
      allChunks = allChunks.filter(chunk => {
        const allowedChapters = filterMap.get(chunk.material_id);
        if (!allowedChapters) {
          return !filterMap.has(chunk.material_id);
        }
        const chunkChapter = chunk.metadata?.chapter;
        return chunkChapter && allowedChapters.has(chunkChapter);
      });
      
      console.log(`[FlashcardGen] Chapter filter applied: ${beforeCount} → ${allChunks.length} chunks`);
      
      if (allChunks.length === 0) {
        throw new Error('No content chunks found for the selected chapters. Please select different chapters or materials.');
      }
    }
  }

  // 3. Try to group by chapter, fall back to topic clustering
  const chapterGroups = groupChunksByChapter(allChunks);
  
  let generationGroups;
  let useChapterMode = false;

  if (chapterGroups && chapterGroups.length > 1) {
    // Chapter structure detected - use two-level hierarchy: Chapter -> Topics within chapter
    useChapterMode = true;
    console.log(`[FlashcardGen] Detected ${chapterGroups.length} chapters, discovering topics within each...`);
    
    // First, calculate flashcard distribution across chapters
    const chapterDistribution = calculateChapterDistribution(chapterGroups, count);
    
    // Then, discover natural topics within each chapter
    generationGroups = [];
    
    for (const chapter of chapterDistribution) {
      if (chapter.chunks.length <= 3) {
        // Small chapter - treat as single topic
        generationGroups.push({
          ...chapter,
          topicLabel: `${chapter.chapterTitle}`,
          centroid: null
        });
      } else {
        // Discover natural topics within this chapter
        const chapterTopics = await clusterChunksByTopic(chapter.chunks);
        
        if (chapterTopics.length === 1) {
          // Chapter has one cohesive topic
          generationGroups.push({
            ...chapter,
            chunks: chapterTopics[0].chunks,
            centroid: chapterTopics[0].centroid,
            topicLabel: `${chapter.chapterTitle}`
          });
        } else {
          // Distribute chapter's flashcards across its topics proportionally
          const totalTopicChunks = chapterTopics.reduce((sum, t) => sum + t.chunks.length, 0);
          
          for (let t = 0; t < chapterTopics.length; t++) {
            const topic = chapterTopics[t];
            const proportion = topic.chunks.length / totalTopicChunks;
            const topicCards = Math.max(1, Math.round(chapter.targetQuestions * proportion));
            
            generationGroups.push({
              chapterNum: chapter.chapterNum,
              chapterTitle: chapter.chapterTitle,
              topicNum: t + 1,
              topicLabel: `${chapter.chapterTitle} - Topic ${t + 1}`,
              chunks: topic.chunks,
              centroid: topic.centroid,
              targetQuestions: topicCards,
              proportion: (proportion * 100).toFixed(1) + '%'
            });
          }
        }
      }
    }
    
    // Adjust totals to match requested count
    let currentTotal = generationGroups.reduce((sum, g) => sum + g.targetQuestions, 0);
    while (currentTotal < count && generationGroups.length > 0) {
      generationGroups.sort((a, b) => b.chunks.length - a.chunks.length)[0].targetQuestions++;
      currentTotal++;
    }
    while (currentTotal > count && generationGroups.length > 0) {
      const largest = generationGroups.sort((a, b) => b.targetQuestions - a.targetQuestions).find(g => g.targetQuestions > 1);
      if (largest) {
        largest.targetQuestions--;
        currentTotal--;
      } else {
        break;
      }
    }
    
    console.log(`[FlashcardGen] Using CHAPTER->TOPIC hierarchy with ${generationGroups.length} topic groups`);
  } else {
    // No chapter structure - use hierarchical clustering to discover natural topics
    console.log(`[FlashcardGen] No chapter structure, discovering natural topic clusters`);
    
    const clusters = await clusterChunksByTopic(allChunks);
    
    console.log(`[FlashcardGen] Discovered ${clusters.length} natural topic clusters from ${allChunks.length} chunks`);
    
    // Distribute proportionally based on cluster size
    const totalClusterChunks = clusters.reduce((sum, c) => sum + c.chunks.length, 0);
    
    generationGroups = clusters.map((cluster, i) => {
      const proportion = cluster.chunks.length / totalClusterChunks;
      const rawTarget = Math.round(count * proportion);
      const minPerCluster = count >= clusters.length ? 1 : 0;
      
      return {
        chapterNum: i + 1,
        chapterTitle: `Topic ${i + 1}`,
        chunks: cluster.chunks,
        centroid: cluster.centroid,
        targetQuestions: Math.max(minPerCluster, rawTarget),
        proportion: (proportion * 100).toFixed(1) + '%'
      };
    });
  }

  // 4. Generate flashcards for each group
  const startTime = Date.now();
  // Buffer to ensure we get enough after deduplication
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
      clustersUsed: generationGroups.length,
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
 * Derive flashcards from multiple choice questions
 * Front = question text
 * Back = the text of the correct answer option
 */
export const deriveFlashcardsFromQuiz = async (options) => {
  const {
    quizId = null,
    questions = null,  // Can pass questions directly instead of quizId
    userId,
    sectionIds = [],
    name = null,
    folderId = null,
    description = null
  } = options;

  if (!userId) {
    throw new Error('User ID is required');
  }

  let quizQuestions = questions;

  // If quizId provided, fetch the questions
  if (quizId && !quizQuestions) {
    const quiz = await getQuiz(quizId);
    if (!quiz) {
      throw new Error('Quiz not found');
    }
    quizQuestions = quiz.questions;
  }

  if (!quizQuestions || quizQuestions.length === 0) {
    throw new Error('No questions provided to derive flashcards from');
  }

  console.log(`[FlashcardDerive] Deriving ${quizQuestions.length} flashcards from quiz questions`);

  // Convert each MC question to a flashcard
  const flashcards = quizQuestions
    .filter(q => q.question && q.options && q.correct_answer)
    .map(q => {
      // Get the correct answer text from the options
      const correctAnswerKey = q.correct_answer || q.correctAnswer;
      let correctAnswerText = '';
      
      if (q.options && correctAnswerKey) {
        // Handle both object and parsed JSON string options
        const opts = typeof q.options === 'string' ? JSON.parse(q.options) : q.options;
        correctAnswerText = opts[correctAnswerKey] || opts[correctAnswerKey.toLowerCase()] || '';
      }

      // If we couldn't get the answer text, use the explanation as fallback
      if (!correctAnswerText && q.explanation) {
        correctAnswerText = q.explanation;
      }

      return {
        front: q.question,
        back: correctAnswerText || `Answer: ${correctAnswerKey}`,
        topic: q.topic,
        chapter: q.chapter,
        difficulty: q.difficulty
      };
    })
    .filter(card => card.front && card.back);

  if (flashcards.length === 0) {
    throw new Error('Could not derive any valid flashcards from the quiz questions');
  }

  console.log(`[FlashcardDerive] Created ${flashcards.length} flashcards`);

  // Store in database
  const setName = name || `Flashcards - ${new Date().toISOString().split('T')[0]}`;
  const flashcardSetId = await storeFlashcards({
    userId,
    sectionIds,
    name: setName,
    flashcards,
    folderId,
    description
  });

  console.log(`[FlashcardDerive] Saved flashcard set with ID: ${flashcardSetId}`);

  return {
    flashcardSetId,
    name: setName,
    description,
    folderId,
    count: flashcards.length,
    flashcards
  };
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
  deriveFlashcardsFromQuiz,
  getQuiz,
  getQuizzesByUser,
  getFlashcardSetsByUser,
  getFlashcardSet,
  deleteQuiz,
  deleteFlashcardSet
};
