/**
 * LLM Service
 * 
 * Uses OpenRouter as the primary provider with model fallback.
 * Primary model: xiaomi/mimo-v2-flash:free
 * Fallback model: tngtech/deepseek-r1t2-chimera:free
 */

import axios from 'axios';

// Model configuration
const PRIMARY_MODEL = 'xiaomi/mimo-v2-flash:free';
const FALLBACK_MODEL = 'tngtech/deepseek-r1t2-chimera:free';

/**
 * Call LLM via OpenRouter
 * 
 * @param {string} text - Context text (e.g., RAG-retrieved chunks)
 * @param {string} instruction - The instruction/prompt
 * @param {object} options - Additional options
 */
export const callLLM = async (text, instruction, options = {}) => {
  const {
    model = null,
    temperature = 0.7,
    maxTokens = 4000
  } = options;

  // Build the prompt - combines instruction with context
  const prompt = text 
    ? `${instruction}\n\nContent:\n${text}`
    : instruction;

  // Use specified model, or default to primary
  const selectedModel = model || PRIMARY_MODEL;

  try {
    return await callOpenRouter(prompt, { 
      model: selectedModel, 
      temperature, 
      maxTokens 
    });
  } catch (error) {
    // If primary model fails, try fallback
    if (selectedModel === PRIMARY_MODEL) {
      console.log(`Primary model failed: ${error.message}`);
      console.log(`Falling back to ${FALLBACK_MODEL}...`);
      
      return await callOpenRouter(prompt, { 
        model: FALLBACK_MODEL, 
        temperature, 
        maxTokens 
      });
    }
    throw error;
  }
};

/**
 * Call OpenRouter API
 */
const callOpenRouter = async (prompt, options = {}) => {
  const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
  const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';

  if (!OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY is not configured');
  }

  const {
    model = PRIMARY_MODEL,
    temperature = 0.7,
    maxTokens = 4000
  } = options;

  try {
    const response = await axios.post(
      `${OPENROUTER_BASE_URL}/chat/completions`,
      {
        model,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature,
        max_tokens: maxTokens
      },
      {
        headers: {
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': process.env.APP_URL || 'http://localhost:3000',
          'X-Title': 'SBHACK26 Backend'
        }
      }
    );

    if (response.data?.choices?.[0]?.message?.content) {
      return response.data.choices[0].message.content;
    }

    throw new Error('Invalid response from OpenRouter API');
  } catch (error) {
    if (error.response) {
      const status = error.response.status;
      const data = error.response.data;
      throw new Error(`OpenRouter API error (${status}): ${JSON.stringify(data)}`);
    }
    throw new Error(`OpenRouter error: ${error.message}`);
  }
};

/**
 * Call LLM with conversation history (for chat-like interactions)
 */
export const callLLMWithHistory = async (messages, options = {}) => {
  const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
  const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';

  if (!OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY is not configured');
  }

  const {
    model = PRIMARY_MODEL,
    temperature = 0.7,
    maxTokens = 4000,
    systemPrompt = null
  } = options;

  const allMessages = systemPrompt 
    ? [{ role: 'system', content: systemPrompt }, ...messages]
    : messages;

  try {
    const response = await axios.post(
      `${OPENROUTER_BASE_URL}/chat/completions`,
      {
        model,
        messages: allMessages,
        temperature,
        max_tokens: maxTokens
      },
      {
        headers: {
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': process.env.APP_URL || 'http://localhost:3000',
          'X-Title': 'SBHACK26 Backend'
        }
      }
    );

    if (response.data?.choices?.[0]?.message?.content) {
      return response.data.choices[0].message.content;
    }

    throw new Error('Invalid response from OpenRouter API');
  } catch (error) {
    if (error.response) {
      throw new Error(`OpenRouter API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
    }
    throw error;
  }
};

/**
 * Stream LLM response (returns full response since OpenRouter streaming requires SSE handling)
 */
export const streamLLM = async function* (prompt, options = {}) {
  // For simplicity, just return the full response
  // OpenRouter does support streaming but requires different handling
  const response = await callLLM('', prompt, options);
  yield response;
};

export default {
  callLLM,
  callLLMWithHistory,
  streamLLM
};
