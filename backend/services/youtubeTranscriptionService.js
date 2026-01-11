/**
 * YouTube Transcription Service
 * 
 * Extracts captions/subtitles from YouTube videos
 * Uses youtube-caption-extractor to get existing captions (auto-generated or user-submitted)
 * 
 * This approach:
 * - Doesn't require downloading audio (fast)
 * - Won't get blocked by YouTube (uses caption API)
 * - Works on cloud servers
 * - Uses YouTube's own transcripts (free)
 */

import { getSubtitles, getVideoDetails } from 'youtube-caption-extractor';

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
  
  // Handle youtu.be URLs
  const shortMatch = url.match(/youtu\.be\/([^?&]+)/);
  if (shortMatch) return shortMatch[1];
  
  // Handle youtube.com/watch?v= URLs
  const watchMatch = url.match(/[?&]v=([^?&]+)/);
  if (watchMatch) return watchMatch[1];
  
  // Handle youtube.com/embed/ URLs
  const embedMatch = url.match(/youtube\.com\/embed\/([^?&]+)/);
  if (embedMatch) return embedMatch[1];
  
  // Handle youtube.com/shorts/ URLs
  const shortsMatch = url.match(/youtube\.com\/shorts\/([^?&]+)/);
  if (shortsMatch) return shortsMatch[1];
  
  return null;
};

/**
 * Get video info from YouTube
 * 
 * @param {string} url - The YouTube URL
 * @returns {Promise<{title: string, duration: number, author: string, videoId: string}>}
 */
export const getVideoInfo = async (url) => {
  try {
    const videoId = extractVideoId(url);
    if (!videoId) {
      throw new Error('Could not extract video ID from URL');
    }

    console.log(`[YouTube] Getting video info for: ${videoId}`);
    
    const details = await getVideoDetails({ videoID: videoId, lang: 'en' });
    
    return {
      title: details.title || 'Unknown Title',
      duration: 0, // Duration not provided by this API
      author: details.description?.split('\n')[0] || 'Unknown Author',
      videoId: videoId,
    };
  } catch (error) {
    console.error('[YouTube] Failed to get video info:', error.message);
    throw new Error(`Failed to get YouTube video info: ${error.message}`);
  }
};

/**
 * Get transcript from YouTube video captions
 * 
 * @param {string} url - The YouTube URL
 * @param {string} lang - Language code (default: 'en')
 * @returns {Promise<string>} - Full transcript text
 */
export const getYouTubeTranscript = async (url, lang = 'en') => {
  const videoId = extractVideoId(url);
  if (!videoId) {
    throw new Error('Could not extract video ID from URL');
  }

  console.log(`[YouTube] Fetching captions for video: ${videoId}, language: ${lang}`);

  try {
    // Try to get subtitles in the requested language
    let subtitles = await getSubtitles({ videoID: videoId, lang: lang });
    
    // If no subtitles in requested language, try without language (get any available)
    if (!subtitles || subtitles.length === 0) {
      console.log(`[YouTube] No ${lang} captions found, trying auto-generated...`);
      subtitles = await getSubtitles({ videoID: videoId });
    }

    if (!subtitles || subtitles.length === 0) {
      throw new Error('No captions available for this video. The video may not have subtitles or auto-generated captions.');
    }

    // Combine all subtitle segments into a full transcript
    const transcript = subtitles
      .map(sub => sub.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    console.log(`[YouTube] Extracted ${subtitles.length} caption segments, ${transcript.length} characters total`);
    
    return transcript;
  } catch (error) {
    console.error('[YouTube] Caption extraction error:', error.message);
    throw new Error(`Failed to extract captions: ${error.message}`);
  }
};

/**
 * Transcribe a YouTube video by extracting its captions
 * 
 * @param {string} url - The YouTube URL
 * @param {function} onProgress - Optional progress callback for status updates
 * @returns {Promise<{transcript: string, videoInfo: object}>}
 */
export const transcribeYouTubeVideo = async (url, onProgress = null) => {
  try {
    // Step 1: Get video info
    if (onProgress) onProgress({ stage: 'info', message: 'Getting video information...' });
    
    const videoId = extractVideoId(url);
    if (!videoId) {
      throw new Error('Invalid YouTube URL');
    }

    // Get video details
    let videoInfo;
    try {
      videoInfo = await getVideoInfo(url);
      console.log(`[YouTube] Processing: "${videoInfo.title}"`);
    } catch (e) {
      // If we can't get video info, continue with just the video ID
      console.warn('[YouTube] Could not get video details, continuing anyway');
      videoInfo = {
        title: `YouTube Video (${videoId})`,
        duration: 0,
        author: 'Unknown',
        videoId: videoId,
      };
    }

    // Step 2: Extract captions
    if (onProgress) onProgress({ stage: 'transcribe', message: 'Extracting video captions...' });
    
    const transcript = await getYouTubeTranscript(url, 'en');

    if (!transcript || transcript.trim().length === 0) {
      throw new Error('No transcript could be extracted from the video');
    }

    console.log(`[YouTube] Transcription complete: ${transcript.length} characters`);

    return {
      transcript,
      videoInfo,
    };

  } catch (error) {
    console.error('[YouTube] Transcription error:', error.message);
    throw error;
  }
};

export default {
  isValidYouTubeUrl,
  extractVideoId,
  getVideoInfo,
  getYouTubeTranscript,
  transcribeYouTubeVideo,
};
