/**
 * YouTube Transcription Service
 * 
 * Downloads audio from YouTube videos and transcribes them using Deepgram
 */

import ytdl from 'ytdl-core';
import { createClient } from '@deepgram/sdk';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

/**
 * Validate a YouTube URL
 * 
 * @param {string} url - The YouTube URL to validate
 * @returns {boolean} - True if valid YouTube URL
 */
export const isValidYouTubeUrl = (url) => {
  if (!url) return false;
  
  // Match various YouTube URL formats
  const patterns = [
    /^(https?:\/\/)?(www\.)?youtube\.com\/watch\?v=[\w-]+/,
    /^(https?:\/\/)?(www\.)?youtube\.com\/embed\/[\w-]+/,
    /^(https?:\/\/)?(www\.)?youtu\.be\/[\w-]+/,
    /^(https?:\/\/)?(www\.)?youtube\.com\/shorts\/[\w-]+/,
  ];
  
  return patterns.some(pattern => pattern.test(url));
};

/**
 * Extract video ID from YouTube URL
 * 
 * @param {string} url - The YouTube URL
 * @returns {string|null} - Video ID or null
 */
export const extractVideoId = (url) => {
  if (!url) return null;
  
  // Try ytdl-core's built-in function first
  try {
    return ytdl.getVideoID(url);
  } catch {
    return null;
  }
};

/**
 * Get video info from YouTube
 * 
 * @param {string} url - The YouTube URL
 * @returns {Promise<{title: string, duration: number, author: string}>}
 */
export const getVideoInfo = async (url) => {
  try {
    const info = await ytdl.getInfo(url);
    return {
      title: info.videoDetails.title,
      duration: parseInt(info.videoDetails.lengthSeconds, 10),
      author: info.videoDetails.author.name,
      videoId: info.videoDetails.videoId,
    };
  } catch (error) {
    console.error('[YouTube] Failed to get video info:', error.message);
    throw new Error(`Failed to get YouTube video info: ${error.message}`);
  }
};

/**
 * Download audio from a YouTube video
 * 
 * @param {string} url - The YouTube URL
 * @param {function} onProgress - Optional progress callback
 * @returns {Promise<string>} - Path to the downloaded audio file
 */
export const downloadYouTubeAudio = async (url, onProgress = null) => {
  if (!isValidYouTubeUrl(url)) {
    throw new Error('Invalid YouTube URL');
  }

  const tempDir = os.tmpdir();
  const filename = `youtube-${uuidv4()}.mp3`;
  const filePath = path.join(tempDir, filename);

  console.log(`[YouTube] Downloading audio from: ${url}`);
  console.log(`[YouTube] Saving to: ${filePath}`);

  return new Promise((resolve, reject) => {
    try {
      const stream = ytdl(url, {
        filter: 'audioonly',
        quality: 'highestaudio',
      });

      const writeStream = fs.createWriteStream(filePath);

      let downloadedBytes = 0;
      let totalBytes = 0;

      stream.on('info', (info, format) => {
        totalBytes = parseInt(format.contentLength, 10) || 0;
        console.log(`[YouTube] Video: ${info.videoDetails.title}`);
        console.log(`[YouTube] Audio format: ${format.mimeType}`);
      });

      stream.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        if (onProgress && totalBytes > 0) {
          const percent = Math.round((downloadedBytes / totalBytes) * 100);
          onProgress({ downloaded: downloadedBytes, total: totalBytes, percent });
        }
      });

      stream.on('error', (error) => {
        console.error('[YouTube] Download error:', error.message);
        // Clean up partial file
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
        reject(new Error(`YouTube download failed: ${error.message}`));
      });

      writeStream.on('finish', () => {
        console.log(`[YouTube] Download complete: ${downloadedBytes} bytes`);
        resolve(filePath);
      });

      writeStream.on('error', (error) => {
        console.error('[YouTube] Write error:', error.message);
        reject(new Error(`Failed to save audio file: ${error.message}`));
      });

      stream.pipe(writeStream);
    } catch (error) {
      console.error('[YouTube] Error setting up download:', error.message);
      reject(new Error(`YouTube download setup failed: ${error.message}`));
    }
  });
};

/**
 * Transcribe a YouTube video using Deepgram
 * 
 * @param {string} url - The YouTube URL
 * @param {function} onProgress - Optional progress callback for status updates
 * @returns {Promise<{transcript: string, videoInfo: object}>}
 */
export const transcribeYouTubeVideo = async (url, onProgress = null) => {
  if (!DEEPGRAM_API_KEY) {
    throw new Error('DEEPGRAM_API_KEY environment variable is not set');
  }

  let audioFilePath = null;

  try {
    // Step 1: Get video info
    if (onProgress) onProgress({ stage: 'info', message: 'Getting video information...' });
    const videoInfo = await getVideoInfo(url);
    console.log(`[YouTube] Processing: "${videoInfo.title}" (${videoInfo.duration}s)`);

    // Check video duration (Deepgram has limits, let's cap at 3 hours)
    const maxDuration = 3 * 60 * 60; // 3 hours in seconds
    if (videoInfo.duration > maxDuration) {
      throw new Error(`Video is too long (${Math.round(videoInfo.duration / 60)} minutes). Maximum supported duration is ${maxDuration / 60} minutes.`);
    }

    // Step 2: Download audio
    if (onProgress) onProgress({ stage: 'download', message: 'Downloading audio from YouTube...' });
    audioFilePath = await downloadYouTubeAudio(url, (progress) => {
      if (onProgress) {
        onProgress({ 
          stage: 'download', 
          message: `Downloading audio... ${progress.percent}%`,
          progress: progress.percent 
        });
      }
    });

    // Step 3: Transcribe with Deepgram
    if (onProgress) onProgress({ stage: 'transcribe', message: 'Transcribing audio with Deepgram...' });
    
    const deepgram = createClient(DEEPGRAM_API_KEY);
    const audioBuffer = fs.readFileSync(audioFilePath);

    console.log(`[YouTube] Sending ${audioBuffer.length} bytes to Deepgram for transcription...`);

    const { result, error } = await deepgram.listen.prerecorded.transcribeFile(
      audioBuffer,
      {
        model: 'nova-3',
        smart_format: true,
        punctuate: true,
        paragraphs: true,
        utterances: false,
      }
    );

    if (error) {
      console.error('[YouTube] Deepgram error:', error);
      throw new Error(`Deepgram transcription failed: ${error.message || error}`);
    }

    const transcript = result?.results?.channels?.[0]?.alternatives?.[0]?.transcript;

    if (!transcript || transcript.trim().length === 0) {
      throw new Error('No transcript could be generated from the video audio');
    }

    console.log(`[YouTube] Transcription complete: ${transcript.length} characters`);

    return {
      transcript,
      videoInfo,
    };

  } finally {
    // Clean up temporary audio file
    if (audioFilePath && fs.existsSync(audioFilePath)) {
      try {
        fs.unlinkSync(audioFilePath);
        console.log('[YouTube] Cleaned up temporary audio file');
      } catch (e) {
        console.warn('[YouTube] Failed to clean up temp file:', e.message);
      }
    }
  }
};

export default {
  isValidYouTubeUrl,
  extractVideoId,
  getVideoInfo,
  downloadYouTubeAudio,
  transcribeYouTubeVideo,
};
