/**
 * RAG Retriever Service
 * 
 * Handles semantic search and retrieval of relevant content chunks
 * using vector similarity search with pgvector.
 */

import { query } from '../config/database.js';
import { generateEmbedding } from './embeddingService.js';
import pgvector from 'pgvector';

/**
 * Retrieve relevant chunks using vector similarity search
 * 
 * @param {string} queryText - The search query or topic
 * @param {Object} options - Search options
 * @returns {Array} - Array of relevant chunks with similarity scores
 */
export const retrieveRelevantChunks = async (queryText, options = {}) => {
  const {
    materialIds = null,
    chapters = null,
    contentTypes = null,
    topK = 20,
    similarityThreshold = 0.5,
    includeContent = true
  } = options;

  // Generate embedding for the query
  // Always use OpenAI to match document embeddings (1536 dimensions)
  const { embedding: queryEmbedding } = await generateEmbedding(queryText, {
    isQuery: true,
    hasMath: options.hasMath,
    provider: 'openai'
  });

  // Build the query with filters
  let sql = `
    SELECT 
      mc.id,
      mc.material_id,
      mc.chunk_index,
      ${includeContent ? 'mc.content,' : ''}
      mc.content_type,
      mc.has_math,
      mc.metadata,
      mc.token_count,
      m.title as material_title,
      m.type as material_type,
      1 - (mc.embedding <=> $1::vector) as similarity
    FROM material_chunks mc
    JOIN materials m ON mc.material_id = m.id
    WHERE mc.embedding IS NOT NULL
  `;

  const params = [pgvector.toSql(queryEmbedding)];
  let paramIndex = 2;

  // Add material filter
  if (materialIds && materialIds.length > 0) {
    sql += ` AND mc.material_id = ANY($${paramIndex})`;
    params.push(materialIds);
    paramIndex++;
  }

  // Add chapter filter (from metadata)
  if (chapters && chapters.length > 0) {
    sql += ` AND (mc.metadata->>'chapter')::int = ANY($${paramIndex})`;
    params.push(chapters);
    paramIndex++;
  }

  // Add content type filter
  if (contentTypes && contentTypes.length > 0) {
    sql += ` AND mc.content_type = ANY($${paramIndex})`;
    params.push(contentTypes);
    paramIndex++;
  }

  // Add similarity threshold and ordering
  sql += `
    AND 1 - (mc.embedding <=> $1::vector) > $${paramIndex}
    ORDER BY mc.embedding <=> $1::vector
    LIMIT $${paramIndex + 1}
  `;
  params.push(similarityThreshold, topK);

  const result = await query(sql, params);

  return result.rows;
};

/**
 * Hybrid search: combine keyword and semantic search
 * Better for specific terms that might not have good semantic matches
 */
export const hybridSearch = async (queryText, options = {}) => {
  const {
    materialIds = null,
    topK = 20,
    keywordWeight = 0.3,
    semanticWeight = 0.7
  } = options;

  // Semantic search
  const semanticResults = await retrieveRelevantChunks(queryText, {
    ...options,
    topK: topK * 2 // Get more for re-ranking
  });

  // Keyword search using PostgreSQL full-text search
  let keywordSql = `
    SELECT 
      mc.id,
      mc.material_id,
      mc.chunk_index,
      mc.content,
      mc.content_type,
      mc.metadata,
      ts_rank(to_tsvector('english', mc.content), plainto_tsquery('english', $1)) as text_rank
    FROM material_chunks mc
    JOIN materials m ON mc.material_id = m.id
    WHERE to_tsvector('english', mc.content) @@ plainto_tsquery('english', $1)
  `;

  const keywordParams = [queryText];
  let paramIndex = 2;

  if (materialIds && materialIds.length > 0) {
    keywordSql += ` AND mc.material_id = ANY($${paramIndex})`;
    keywordParams.push(materialIds);
    paramIndex++;
  }

  keywordSql += ` ORDER BY text_rank DESC LIMIT $${paramIndex}`;
  keywordParams.push(topK * 2);

  let keywordResults = [];
  try {
    const keywordResult = await query(keywordSql, keywordParams);
    keywordResults = keywordResult.rows;
  } catch (error) {
    console.warn('Keyword search failed, using semantic only:', error.message);
  }

  // Combine and re-rank results
  const combinedMap = new Map();

  // Add semantic results with weighted score
  for (const result of semanticResults) {
    combinedMap.set(result.id, {
      ...result,
      combinedScore: result.similarity * semanticWeight,
      semanticScore: result.similarity,
      keywordScore: 0
    });
  }

  // Add keyword results with weighted score
  const maxTextRank = Math.max(...keywordResults.map(r => r.text_rank || 0), 1);
  for (const result of keywordResults) {
    const normalizedRank = (result.text_rank || 0) / maxTextRank;
    
    if (combinedMap.has(result.id)) {
      const existing = combinedMap.get(result.id);
      existing.combinedScore += normalizedRank * keywordWeight;
      existing.keywordScore = normalizedRank;
    } else {
      combinedMap.set(result.id, {
        ...result,
        combinedScore: normalizedRank * keywordWeight,
        semanticScore: 0,
        keywordScore: normalizedRank
      });
    }
  }

  // Sort by combined score and return top K
  const combined = Array.from(combinedMap.values())
    .sort((a, b) => b.combinedScore - a.combinedScore)
    .slice(0, topK);

  return combined;
};

/**
 * Find similar chunks to a given chunk (for avoiding duplicate questions)
 */
export const findSimilarChunks = async (chunkId, threshold = 0.85) => {
  const sql = `
    WITH target AS (
      SELECT embedding FROM material_chunks WHERE id = $1
    )
    SELECT 
      mc.id,
      mc.content,
      1 - (mc.embedding <=> target.embedding) as similarity
    FROM material_chunks mc, target
    WHERE mc.id != $1
      AND mc.embedding IS NOT NULL
      AND 1 - (mc.embedding <=> target.embedding) > $2
    ORDER BY mc.embedding <=> target.embedding
    LIMIT 10
  `;

  const result = await query(sql, [chunkId, threshold]);
  return result.rows;
};

/**
 * Get context window for a specific chunk (include surrounding chunks)
 */
export const getChunkContext = async (chunkId, windowSize = 2) => {
  // First get the chunk info
  const chunkResult = await query(
    `SELECT material_id, chunk_index FROM material_chunks WHERE id = $1`,
    [chunkId]
  );

  if (chunkResult.rows.length === 0) {
    return null;
  }

  const { material_id, chunk_index } = chunkResult.rows[0];

  // Get surrounding chunks
  const contextResult = await query(
    `SELECT id, chunk_index, content, content_type, metadata
     FROM material_chunks
     WHERE material_id = $1
       AND chunk_index BETWEEN $2 AND $3
     ORDER BY chunk_index`,
    [material_id, chunk_index - windowSize, chunk_index + windowSize]
  );

  return {
    chunks: contextResult.rows,
    centerIndex: chunk_index
  };
};

export default {
  retrieveRelevantChunks,
  hybridSearch,
  findSimilarChunks,
  getChunkContext
};
