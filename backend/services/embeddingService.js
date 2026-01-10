/**
 * Embedding Service
 * 
 * Supports multiple embedding providers:
 * - OpenAI (text-embedding-3-small, text-embedding-3-large)
 * - Voyage AI (voyage-3, voyage-code-3) - Better for STEM/Math
 */

import OpenAI from 'openai';

// Lazy initialization of OpenAI client
let openaiClient = null;

const getOpenAIClient = () => {
  if (!openaiClient && process.env.OPENAI_API_KEY) {
    openaiClient = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
  }
  return openaiClient;
};

// Configuration
const EMBEDDING_CONFIG = {
  openai: {
    small: {
      model: 'text-embedding-3-small',
      dimensions: 1536,
      maxTokens: 8191,
      costPer1M: 0.02
    },
    large: {
      model: 'text-embedding-3-large',
      dimensions: 3072, // Can be reduced to 1536 or 1024
      maxTokens: 8191,
      costPer1M: 0.13
    }
  },
  voyage: {
    default: {
      model: 'voyage-3',
      dimensions: 1024,
      maxTokens: 32000,
      costPer1M: 0.06
    },
    code: {
      model: 'voyage-code-3',
      dimensions: 1024,
      maxTokens: 32000,
      costPer1M: 0.06
    }
  }
};

/**
 * Generate embedding using OpenAI
 */
export const generateOpenAIEmbedding = async (text, options = {}) => {
  const openai = getOpenAIClient();
  
  if (!openai) {
    throw new Error('OPENAI_API_KEY is not configured');
  }

  const config = options.large 
    ? EMBEDDING_CONFIG.openai.large 
    : EMBEDDING_CONFIG.openai.small;
  
  try {
    const response = await openai.embeddings.create({
      model: config.model,
      input: text,
      dimensions: options.dimensions || 1536 // Normalize to 1536 for consistency
    });

    return {
      embedding: response.data[0].embedding,
      model: config.model,
      dimensions: options.dimensions || 1536,
      usage: response.usage
    };
  } catch (error) {
    console.error('OpenAI embedding error:', error.message);
    throw new Error(`Failed to generate OpenAI embedding: ${error.message}`);
  }
};

/**
 * Generate embedding using Voyage AI
 * Better for technical/STEM content including math
 */
export const generateVoyageEmbedding = async (text, options = {}) => {
  const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY;
  
  if (!VOYAGE_API_KEY) {
    throw new Error('VOYAGE_API_KEY is not configured');
  }

  const config = options.code 
    ? EMBEDDING_CONFIG.voyage.code 
    : EMBEDDING_CONFIG.voyage.default;

  try {
    const response = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${VOYAGE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: config.model,
        input: text,
        input_type: options.inputType || 'document' // 'document' or 'query'
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Voyage API error');
    }

    const data = await response.json();

    return {
      embedding: data.data[0].embedding,
      model: config.model,
      dimensions: config.dimensions,
      usage: data.usage
    };
  } catch (error) {
    console.error('Voyage embedding error:', error.message);
    throw new Error(`Failed to generate Voyage embedding: ${error.message}`);
  }
};

/**
 * Generate embedding with automatic provider selection
 * 
 * @param {string} text - Text to embed
 * @param {object} options - Options
 * @param {string} options.provider - 'openai' | 'voyage' | 'auto'
 * @param {boolean} options.hasMath - Whether text contains math
 * @param {boolean} options.isQuery - Whether this is a search query (vs document)
 */
export const generateEmbedding = async (text, options = {}) => {
  const provider = options.provider || process.env.EMBEDDING_PROVIDER || 'openai';
  
  // Auto-select provider based on content
  if (provider === 'auto') {
    // Use Voyage for math-heavy content if available
    if (options.hasMath && process.env.VOYAGE_API_KEY) {
      return generateVoyageEmbedding(text, {
        inputType: options.isQuery ? 'query' : 'document'
      });
    }
    // Default to OpenAI
    return generateOpenAIEmbedding(text);
  }

  if (provider === 'voyage') {
    return generateVoyageEmbedding(text, {
      inputType: options.isQuery ? 'query' : 'document',
      code: options.hasCode
    });
  }

  return generateOpenAIEmbedding(text, {
    large: options.large
  });
};

/**
 * Generate embeddings for multiple texts (batch)
 * More efficient than generating one at a time
 * Batches by token count to stay under API limits
 */
export const generateBatchEmbeddings = async (texts, options = {}) => {
  const provider = options.provider || process.env.EMBEDDING_PROVIDER || 'openai';
  // OpenAI max is 300k tokens per request, use 250k to be safe
  const maxTokensPerBatch = options.maxTokensPerBatch || 250000;
  const maxTextsPerBatch = options.batchSize || 100;
  const results = [];

  // Build batches based on token count
  const batches = [];
  let currentBatch = [];
  let currentTokenCount = 0;

  for (const text of texts) {
    const tokenCount = estimateTokenCount(text);
    
    // Check if adding this text would exceed limits
    if (currentBatch.length > 0 && 
        (currentTokenCount + tokenCount > maxTokensPerBatch || 
         currentBatch.length >= maxTextsPerBatch)) {
      batches.push(currentBatch);
      currentBatch = [];
      currentTokenCount = 0;
    }
    
    currentBatch.push(text);
    currentTokenCount += tokenCount;
  }
  
  // Don't forget the last batch
  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  console.log(`Processing ${texts.length} texts in ${batches.length} batches`);

  // Process each batch
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    console.log(`Processing batch ${i + 1}/${batches.length} (${batch.length} texts)`);
    
    if (provider === 'voyage' || (provider === 'auto' && options.hasMath)) {
      // Voyage supports batch natively
      const batchResults = await generateVoyageBatchEmbeddings(batch, options);
      results.push(...batchResults);
    } else {
      // OpenAI batch
      const batchResults = await generateOpenAIBatchEmbeddings(batch, options);
      results.push(...batchResults);
    }

    // Rate limiting between batches
    if (i < batches.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  return results;
};

/**
 * OpenAI batch embeddings
 */
const generateOpenAIBatchEmbeddings = async (texts, options = {}) => {
  const openai = getOpenAIClient();
  
  if (!openai) {
    throw new Error('OPENAI_API_KEY is not configured');
  }

  const config = EMBEDDING_CONFIG.openai.small;
  
  // Truncate any texts that exceed the per-text token limit
  // Use 6000 tokens (vs 8191 max) as safety margin for tokenization variance
  // PDF content with special characters can have higher token-to-char ratio
  const safeTokenLimit = 6000;
  const processedTexts = texts.map(text => truncateToTokenLimit(text, safeTokenLimit));

  try {
    const response = await openai.embeddings.create({
      model: config.model,
      input: processedTexts,
      dimensions: 1536
    });

    return response.data.map((item, index) => ({
      embedding: item.embedding,
      index: item.index,
      text: texts[index] // Return original text for reference
    }));
  } catch (error) {
    console.error('OpenAI batch embedding error:', error.message);
    throw error;
  }
};

/**
 * Voyage batch embeddings
 */
const generateVoyageBatchEmbeddings = async (texts, options = {}) => {
  const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY;
  
  if (!VOYAGE_API_KEY) {
    // Fallback to OpenAI if Voyage not configured
    console.warn('Voyage API key not found, falling back to OpenAI');
    return generateOpenAIBatchEmbeddings(texts, options);
  }

  const config = EMBEDDING_CONFIG.voyage.default;

  try {
    const response = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${VOYAGE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: config.model,
        input: texts,
        input_type: options.inputType || 'document'
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Voyage API error');
    }

    const data = await response.json();

    return data.data.map((item, index) => ({
      embedding: item.embedding,
      index: index,
      text: texts[index]
    }));
  } catch (error) {
    console.error('Voyage batch embedding error:', error.message);
    throw error;
  }
};

/**
 * Calculate cosine similarity between two embeddings
 */
export const cosineSimilarity = (a, b) => {
  if (a.length !== b.length) {
    throw new Error('Embeddings must have same dimensions');
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
};

/**
 * Count tokens (approximate)
 * OpenAI tokenization is roughly:
 * - ~4 characters per token for English
 * - ~3 characters per token for code/technical content
 * Using conservative estimate of 3 chars per token
 */
export const estimateTokenCount = (text) => {
  if (!text) return 0;
  // Conservative estimation: ~3 characters per token
  return Math.ceil(text.length / 3);
};

/**
 * Truncate text to fit within token limit
 * Uses a very conservative 1.5 chars per token to ensure we stay under limits
 * (actual ratio varies: ~4 for English, ~1-2 for code/special chars/PDFs)
 */
export const truncateToTokenLimit = (text, maxTokens = 8000) => {
  if (!text) return text;
  
  // Use very conservative estimate: 1.5 chars per token for truncation
  // PDF content and special characters can have very high token-to-char ratio
  const conservativeMaxChars = Math.floor(maxTokens * 1.5);
  
  if (text.length <= conservativeMaxChars) {
    return text;
  }
  
  // Truncate and add ellipsis to indicate truncation
  return text.substring(0, conservativeMaxChars - 3) + '...';
};

export default {
  generateEmbedding,
  generateBatchEmbeddings,
  generateOpenAIEmbedding,
  generateVoyageEmbedding,
  cosineSimilarity,
  estimateTokenCount,
  truncateToTokenLimit,
  EMBEDDING_CONFIG
};
