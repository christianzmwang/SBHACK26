import { processDocuments } from '../services/documentProcessor.js';
import { callLLM } from '../services/llmService.js';
import { textToSpeech } from '../services/ttsService.js';
import { handleError } from '../services/utils.js';

const PRESET_INSTRUCTIONS = {
  '5 years old': 'Explain this content in very simple terms suitable for a 5-year-old child. Use short sentences, simple words, and fun analogies.',
  'middle school': 'Explain this content in a clear and engaging way suitable for middle school students. Use age-appropriate language and examples.',
  'high school': 'Explain this content comprehensively for high school students. Include relevant context and examples.',
  'college': 'Provide a detailed and comprehensive explanation suitable for college-level understanding. Include academic context and analysis.'
};

export const generateController = async (req, res) => {
  try {
    const { preset } = req.body;
    const files = req.files || [];

    if (!preset) {
      return res.status(400).json({ error: 'Preset is required' });
    }

    if (!PRESET_INSTRUCTIONS[preset]) {
      return res.status(400).json({ error: 'Invalid preset selected' });
    }

    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No documents provided' });
    }

    const extractedText = await processDocuments(files);
    
    if (!extractedText || extractedText.trim().length === 0) {
      return res.status(400).json({ error: 'No text could be extracted from documents' });
    }

    const instruction = PRESET_INSTRUCTIONS[preset];
    const llmResponse = await callLLM(extractedText, instruction);

    const ttsResult = await textToSpeech(llmResponse);

    res.json({
      success: true,
      llmOutput: llmResponse,
      ttsAudio: ttsResult.audio,
      ttsMetadata: ttsResult.metadata
    });
  } catch (error) {
    handleError(error, res);
  }
};
