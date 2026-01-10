import express from 'express';
import { streamChatCompletion } from '../services/llmService.js';

const router = express.Router();

/**
 * POST /api/voice/token
 * Generate a temporary Deepgram token for client-side use
 */
router.post('/token', async (req, res) => {
  try {
    const deepgramApiKey = process.env.DEEPGRAM_API_KEY;
    
    if (!deepgramApiKey) {
      return res.status(500).json({ error: 'Deepgram API key not configured' });
    }

    // Generate temporary token from Deepgram
    const response = await fetch('https://api.deepgram.com/v1/auth/grant', {
      method: 'POST',
      headers: {
        'Authorization': `Token ${deepgramApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ttl_seconds: 300, // 5 minutes
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('Deepgram token generation failed:', error);
      return res.status(response.status).json({ 
        error: 'Failed to generate Deepgram token',
        details: error 
      });
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Error generating Deepgram token:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/voice/chat
 * Stream LLM responses with practice context
 * Body: { transcript: string, context: object }
 */
router.post('/chat', async (req, res) => {
  try {
    const { transcript, context } = req.body;

    if (!transcript) {
      return res.status(400).json({ error: 'Transcript is required' });
    }

    // Set up SSE headers for streaming
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Build system prompt based on context
    let systemPrompt = `You are a helpful study assistant helping a student practice their course material. `;
    
    if (context?.viewMode === 'quiz' && context?.currentQuestion) {
      const q = context.currentQuestion;
      systemPrompt += `\n\nThe student is currently taking a quiz. `;
      systemPrompt += `\nCurrent Question (${context.currentQuestionIndex + 1}/${context.totalQuestions}): ${q.question}`;
      
      if (q.options) {
        systemPrompt += `\nOptions:\n`;
        Object.entries(q.options).forEach(([key, value]) => {
          systemPrompt += `  ${key}. ${value}\n`;
        });
      }
      
      if (context.userAnswer) {
        systemPrompt += `\nStudent's current answer: ${context.userAnswer}`;
      } else {
        systemPrompt += `\nThe student hasn't answered yet.`;
      }
      
      systemPrompt += `\n\nHelp them understand the question, provide hints if asked, but don't give away the answer directly unless they specifically ask for it. Encourage critical thinking.`;
    } else if (context?.viewMode === 'quiz' && context?.showResults) {
      systemPrompt += `\n\nThe student just completed a quiz.`;
      systemPrompt += `\nScore: ${context.score?.correct}/${context.score?.total} (${context.score?.percentage}%)`;
      systemPrompt += `\n\nHelp them understand what they got wrong, explain concepts they struggled with, and encourage them. Be supportive and educational.`;
    } else if (context?.viewMode === 'flashcards' && context?.currentCard) {
      const card = context.currentCard;
      systemPrompt += `\n\nThe student is studying flashcards.`;
      systemPrompt += `\nCurrent Card (${context.currentCardIndex + 1}/${context.totalCards}):`;
      systemPrompt += `\nFront: ${card.front || card.question}`;
      
      if (context.isFlipped) {
        systemPrompt += `\nBack: ${card.back || card.explanation}`;
        if (card.topic) {
          systemPrompt += `\nTopic: ${card.topic}`;
        }
      } else {
        systemPrompt += `\n\nThe card is currently showing the front (question) side. The student hasn't flipped it yet.`;
      }
      
      systemPrompt += `\n\nHelp them learn the material. If the card isn't flipped yet, help them think about the answer before revealing it. If it's flipped, help them understand and remember the concept.`;
    } else if (context?.viewMode === 'overview') {
      systemPrompt += `\n\nThe student is viewing their practice overview.`;
      if (context.stats) {
        systemPrompt += `\nThey have ${context.stats.totalQuizzes} quizzes and ${context.stats.totalFlashcards} flashcard sets.`;
      }
      systemPrompt += `\n\nHelp them decide what to study, explain features, or answer general questions about their practice materials.`;
    } else {
      systemPrompt += `\n\nHelp the student with their studies. Answer questions, provide explanations, and encourage their learning.`;
    }

    systemPrompt += `\n\nKeep responses concise and conversational since this is a voice interaction. Speak naturally as if having a conversation.`;

    // Stream response from LLM
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: transcript }
    ];

    let fullResponse = '';
    
    for await (const chunk of streamChatCompletion(messages)) {
      fullResponse += chunk;
      // Send SSE format
      res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`);
    }

    // Send completion signal
    res.write(`data: ${JSON.stringify({ done: true, fullText: fullResponse })}\n\n`);
    res.end();

  } catch (error) {
    console.error('Error in voice chat:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    } else {
      res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
      res.end();
    }
  }
});

/**
 * POST /api/voice/tts
 * Convert text to speech using Deepgram
 * Body: { text: string }
 */
router.post('/tts', async (req, res) => {
  try {
    const { text } = req.body;

    if (!text) {
      return res.status(400).json({ error: 'Text is required' });
    }

    const deepgramApiKey = process.env.DEEPGRAM_API_KEY;
    
    if (!deepgramApiKey) {
      return res.status(500).json({ error: 'Deepgram API key not configured' });
    }

    // Call Deepgram TTS API
    const response = await fetch('https://api.deepgram.com/v1/speak?model=aura-asteria-en', {
      method: 'POST',
      headers: {
        'Authorization': `Token ${deepgramApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('Deepgram TTS failed:', error);
      return res.status(response.status).json({ 
        error: 'Failed to generate speech',
        details: error 
      });
    }

    // Stream audio back to client
    res.setHeader('Content-Type', 'audio/mpeg');
    response.body.pipe(res);

  } catch (error) {
    console.error('Error in TTS:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
