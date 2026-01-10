/**
 * Audio Transcription Service
 * 
 * Uses Deepgram API to transcribe audio files to text
 */

import { createClient } from '@deepgram/sdk';
import fs from 'fs/promises';

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

/**
 * Transcribe an audio file to text using Deepgram
 * 
 * @param {string} filePath - Path to the audio file
 * @returns {Promise<string>} - Transcribed text
 */
export const transcribeAudio = async (filePath) => {
  if (!DEEPGRAM_API_KEY) {
    throw new Error('DEEPGRAM_API_KEY environment variable is not set');
  }

  try {
    console.log(`[Audio Transcription] Starting transcription for: ${filePath}`);
    
    // Create Deepgram client
    const deepgram = createClient(DEEPGRAM_API_KEY);

    // Read the audio file
    const audioBuffer = await fs.readFile(filePath);

    // Transcribe the audio file using pre-recorded transcription
    const { result, error } = await deepgram.listen.prerecorded.transcribeFile(
      audioBuffer,
      {
        model: 'nova-3',
        smart_format: true,  // Enable smart formatting for better readability
        punctuate: true,     // Add punctuation
        paragraphs: true,    // Break into paragraphs
        utterances: false,   // Don't split by speaker
      }
    );

    if (error) {
      console.error('[Audio Transcription] Deepgram error:', error);
      throw new Error(`Deepgram transcription failed: ${error.message || error}`);
    }

    // Extract transcript from the result
    const transcript = result?.results?.channels?.[0]?.alternatives?.[0]?.transcript;

    if (!transcript || transcript.trim().length === 0) {
      console.warn('[Audio Transcription] No transcript returned from Deepgram');
      throw new Error('No transcript could be generated from the audio file');
    }

    console.log(`[Audio Transcription] Successfully transcribed ${transcript.length} characters`);
    return transcript;

  } catch (error) {
    console.error('[Audio Transcription] Error:', error.message);
    throw new Error(`Audio transcription failed: ${error.message}`);
  }
};

/**
 * Check if the audio file is valid for transcription
 * 
 * @param {string} filePath - Path to the audio file
 * @returns {Promise<boolean>}
 */
export const validateAudioFile = async (filePath) => {
  try {
    const stats = await fs.stat(filePath);
    
    // Check file size (Deepgram has a 2GB limit for pre-recorded)
    const maxSize = 2 * 1024 * 1024 * 1024; // 2GB in bytes
    if (stats.size > maxSize) {
      throw new Error('Audio file exceeds maximum size of 2GB');
    }

    // Check if file exists and is readable
    if (stats.size === 0) {
      throw new Error('Audio file is empty');
    }

    return true;
  } catch (error) {
    throw new Error(`Audio file validation failed: ${error.message}`);
  }
};

export default {
  transcribeAudio,
  validateAudioFile
};
