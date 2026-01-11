import express from 'express';
import { streamChatCompletion, chatCompletion } from '../services/llmService.js';
import { query } from '../config/database.js';

const router = express.Router();

// =====================
// VOICE COMMAND DETECTION
// =====================

/**
 * Detect intent and extract parameters from voice transcript
 * Uses LLM to understand natural language commands
 */
async function detectVoiceIntent(transcript, context, userId) {
  // Get available materials/folders for context
  let availableMaterials = [];
  let availableFolders = [];
  
  if (userId) {
    try {
      // Get folders with their sections
      const foldersResult = await query(`
        SELECT f.id, f.name, 
               json_agg(json_build_object('id', fs.id, 'title', fs.title)) as sections
        FROM folders f
        LEFT JOIN folder_sections fs ON fs.folder_id = f.id
        WHERE f.user_id = $1
        GROUP BY f.id, f.name
      `, [userId]);
      
      availableFolders = foldersResult.rows.map(f => ({
        id: f.id,
        name: f.name,
        sections: f.sections.filter(s => s.id !== null)
      }));
      
      // Flatten sections for easier matching
      availableMaterials = foldersResult.rows.flatMap(f => 
        f.sections
          .filter(s => s.id !== null)
          .map(s => ({ id: s.id, title: s.title, folderName: f.name, folderId: f.id }))
      );
    } catch (err) {
      console.error('Error fetching materials for voice intent:', err);
    }
  }

  const intentPrompt = `You are a voice command parser for a study application. Analyze the user's spoken command and determine what action they want to take.

AVAILABLE ACTIONS:
1. GENERATE_QUIZ - User wants to generate/create a quiz or practice questions
2. ANSWER_QUESTION - User is answering a quiz question (A, B, C, D, or the answer text)
3. NEXT_QUESTION - User wants to go to the next question
4. PREV_QUESTION - User wants to go to the previous question
5. SUBMIT_QUIZ - User wants to submit/finish the quiz
6. FLIP_CARD - User wants to flip the flashcard / show the answer
7. NEXT_CARD - User wants to go to the next flashcard
8. PREV_CARD - User wants to go to the previous flashcard
9. EXIT_PRACTICE - User wants to exit/go back from current practice
10. REPEAT_QUESTION - User wants to hear the current question read again
11. REPEAT_ANSWERS - User wants to hear the answer options read again
12. SKIP_QUESTION - User wants to skip the current question and move to the next
13. REPEAT_CARD - User wants to hear the current flashcard read again
14. NONE - No specific action detected, just a conversational query

CURRENT CONTEXT:
- View Mode: ${context?.viewMode || 'overview'}
- ${context?.viewMode === 'quiz' && !context?.showResults ? `Taking Quiz: Question ${(context?.currentQuestionIndex || 0) + 1} of ${context?.totalQuestions || '?'}` : ''}
- ${context?.viewMode === 'quiz' && context?.showResults ? 'Viewing Quiz Results' : ''}
- ${context?.viewMode === 'flashcards' ? `Studying Flashcards: Card ${(context?.currentCardIndex || 0) + 1} of ${context?.totalCards || '?'}, ${context?.isFlipped ? 'showing answer' : 'showing question'}` : ''}

AVAILABLE MATERIALS (user's uploaded content):
${availableMaterials.length > 0 
  ? availableMaterials.map(m => `- "${m.title}" in folder "${m.folderName}" (section_id: ${m.id})`).join('\n')
  : 'No materials uploaded yet'
}

AVAILABLE FOLDERS:
${availableFolders.length > 0
  ? availableFolders.map(f => `- "${f.name}" (folder_id: ${f.id}, contains ${f.sections.length} sections)`).join('\n')
  : 'No folders yet'
}

USER COMMAND: "${transcript}"

Respond with ONLY a JSON object (no markdown, no explanation):
{
  "action": "ACTION_NAME",
  "params": {
    // For GENERATE_QUIZ:
    "questionCount": number or null,
    "materialName": "matched material name" or null,
    "folderName": "matched folder name" or null,
    "sectionIds": ["array of section IDs"] or null,
    "folderId": "folder ID" or null,
    
    // For ANSWER_QUESTION:
    "answer": "A" | "B" | "C" | "D" | "answer text" or null
  },
  "confidence": 0.0 to 1.0,
  "conversationalResponse": "What to say to the user about this action"
}

Important matching rules:
- Match material/folder names flexibly (e.g., "biology notes" matches "Biology Lecture Notes")
- For quiz generation, if a folder is mentioned, include ALL section IDs from that folder
- If user says a number for question count (e.g., "50 questions", "100", "generate 160"), extract it
- For answers, map common phrases: "first option" → "A", "second" → "B", "third" → "C", "fourth" → "D", "true" → "A", "false" → "B", "option 1" → "A", "option 2" → "B", "option 3" → "C", "option 4" → "D"
- CRITICAL: If context shows we're in a quiz and user says a single letter (A, B, C, D) even with punctuation like "A.", "B,", "c,", "D." → ANSWER_QUESTION with that letter. High confidence (0.95+).
- "show answer", "reveal", "flip", "what's the answer", "flip card" → FLIP_CARD (in flashcard context)
- "next", "continue", "next card" → NEXT_QUESTION or NEXT_CARD based on context
- "previous card", "go back", "last card" → PREV_CARD (in flashcard context)
- "repeat", "repeat card", "say that again", "read again", "read card" → REPEAT_CARD (in flashcard context)
- "skip", "skip question", "skip this one" → SKIP_QUESTION (in quiz context)
- "back", "previous", "go back" → PREV_QUESTION, PREV_CARD, or EXIT_PRACTICE based on context
- "done", "finish", "submit", "I'm done" → SUBMIT_QUIZ
- "exit", "quit", "stop", "leave" → EXIT_PRACTICE
- "repeat", "repeat question", "say that again", "what was the question", "read question" → REPEAT_QUESTION (in quiz context)
- "read the answers", "what are the options", "read options", "repeat answers" → REPEAT_ANSWERS (in quiz context)
- For ANSWER_QUESTION actions, leave conversationalResponse empty or null (the frontend handles the response)
`;

  try {
    const response = await chatCompletion([
      { role: 'system', content: intentPrompt },
      { role: 'user', content: transcript }
    ], { 
      temperature: 0.1,
      max_tokens: 500
    });

    // Parse the JSON response - remove markdown code fences if present
    // Using \x60 (backtick) to avoid any encoding issues
    const codeBlockRegex = new RegExp('\x60\x60\x60json\\n?|\\n?\x60\x60\x60', 'g');
    const cleanResponse = response.replace(codeBlockRegex, '').trim();
    const intentResult = JSON.parse(cleanResponse);
    
    return {
      ...intentResult,
      availableMaterials,
      availableFolders
    };
  } catch (err) {
    console.error('Error detecting voice intent:', err);
    return {
      action: 'NONE',
      params: {},
      confidence: 0,
      conversationalResponse: null,
      availableMaterials,
      availableFolders
    };
  }
}

/**
 * POST /api/voice/token
 * Provide Deepgram API key for client-side WebSocket connection
 * 
 * Note: This returns the API key directly. For production with untrusted clients,
 * consider using Deepgram's scoped keys or proxy the WebSocket through your server.
 */
router.post('/token', async (req, res) => {
  try {
    const deepgramApiKey = process.env.DEEPGRAM_API_KEY;
    
    if (!deepgramApiKey) {
      console.error('DEEPGRAM_API_KEY is not set in environment variables');
      return res.status(500).json({ error: 'Deepgram API key not configured' });
    }

    // Return the API key for WebSocket authentication
    // The client will use this with the WebSocket connection
    res.json({ 
      access_token: deepgramApiKey,
      token_type: 'Token',
      expires_in: 3600 // Key doesn't expire, but client can refresh hourly
    });
  } catch (error) {
    console.error('Error in token endpoint:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/voice/chat
 * Stream LLM responses with practice context and action detection
 * Body: { transcript: string, context: object, userId?: string }
 */
router.post('/chat', async (req, res) => {
  try {
    const { transcript, context, userId } = req.body;

    if (!transcript) {
      return res.status(400).json({ error: 'Transcript is required' });
    }

    // Set up SSE headers for streaming
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // First, detect intent to see if this is a command
    const intent = await detectVoiceIntent(transcript, context, userId);
    console.log('Detected voice intent:', JSON.stringify(intent, null, 2));

    // If we detected a high-confidence action, send it first
    if (intent.action !== 'NONE' && intent.confidence >= 0.7) {
      res.write(`data: ${JSON.stringify({
        action: intent.action,
        params: intent.params,
        confidence: intent.confidence
      })}\n\n`);

      // For action commands, use the conversational response if available
      if (intent.conversationalResponse) {
        res.write(`data: ${JSON.stringify({ text: intent.conversationalResponse })}\n\n`);
        res.write(`data: ${JSON.stringify({ done: true, fullText: intent.conversationalResponse })}\n\n`);
        res.end();
        return;
      }

      // For certain actions, don't generate LLM response (frontend handles it)
      const silentActions = ['ANSWER_QUESTION', 'NEXT_QUESTION', 'PREV_QUESTION', 'NEXT_CARD', 'PREV_CARD', 'FLIP_CARD'];
      if (silentActions.includes(intent.action)) {
        res.write(`data: ${JSON.stringify({ done: true, fullText: '' })}\n\n`);
        res.end();
        return;
      }
    }

    // Build system prompt based on context
    let systemPrompt = `You are a helpful study assistant helping a student practice their course material. `;
    
    // Check for quiz results FIRST (before currentQuestion check)
    if (context?.viewMode === 'quiz' && context?.showResults) {
      systemPrompt += `\n\nThe student just completed a quiz.`;
      if (context.quizName) {
        systemPrompt += `\nQuiz: ${context.quizName}`;
      }
      systemPrompt += `\nScore: ${context.score?.correct}/${context.score?.total} (${context.score?.percentage}%)`;
      
      // Include detailed results if available
      if (context.incorrectQuestions && context.incorrectQuestions.length > 0) {
        systemPrompt += `\n\n=== QUESTIONS THE STUDENT GOT WRONG ===`;
        context.incorrectQuestions.forEach((q, idx) => {
          systemPrompt += `\n\nQuestion ${q.questionNumber}: ${q.questionText}`;
          systemPrompt += `\n  Student's Answer: ${q.userAnswer}`;
          systemPrompt += `\n  Correct Answer: ${q.correctAnswer}`;
          if (q.explanation) {
            systemPrompt += `\n  Explanation: ${q.explanation}`;
          }
        });
      }
      
      if (context.correctQuestions && context.correctQuestions.length > 0) {
        systemPrompt += `\n\n=== QUESTIONS THE STUDENT GOT CORRECT ===`;
        systemPrompt += `\nQuestion numbers: ${context.correctQuestions.join(', ')}`;
      }
      
      // Include all question details for reference
      if (context.questionResults && context.questionResults.length > 0) {
        systemPrompt += `\n\n=== FULL QUIZ BREAKDOWN ===`;
        context.questionResults.forEach(q => {
          const status = q.isCorrect ? '✓ CORRECT' : '✗ WRONG';
          systemPrompt += `\n${q.questionNumber}. [${status}] ${q.questionText}`;
        });
      }
      
      systemPrompt += `\n\nHelp them understand what they got wrong, explain the concepts behind incorrect answers, and provide study tips. Be supportive, educational, and encouraging. You have full access to which questions they missed and can explain any of them in detail.`;
    } else if (context?.viewMode === 'quiz' && context?.currentQuestion) {
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

    // Get audio as buffer and send (works with Vercel)
    const audioBuffer = await response.arrayBuffer();
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', audioBuffer.byteLength);
    res.send(Buffer.from(audioBuffer));

  } catch (error) {
    console.error('Error in TTS:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
