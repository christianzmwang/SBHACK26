/**
 * Advanced Document Processor
 * 
 * Handles document upload, text extraction, chunking, and embedding generation.
 * Supports PDF, DOCX, TXT, Markdown, and MP3 audio files.
 * STEM-aware processing with specialized handling for technical content.
 */

import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import { MathAwareChunker, SimpleChunker } from './mathAwareChunker.js';
import { generateBatchEmbeddings, estimateTokenCount, cosineSimilarity } from './embeddingService.js';
import { query, transaction } from '../config/database.js';
import { transcribeAudio, validateAudioFile } from './audioTranscriptionService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKER_PATH = path.resolve(__dirname, '../workers/clusterWorker.js');

/**
 * Process uploaded documents and store in database
 * 
 * @param {Array} files - Uploaded files from multer
 * @param {Object} metadata - Document metadata (type, title, etc.)
 * @returns {Object} - Processing result with material ID
 */
export const processAndStoreDocuments = async (files, metadata) => {
  const results = [];

  for (const file of files) {
    try {
      const result = await processDocument(file, metadata);
      results.push(result);
    } catch (error) {
      console.error(`Error processing ${file.originalname}:`, error.message);
      results.push({
        fileName: file.originalname,
        success: false,
        error: error.message
      });
    } finally {
      // Clean up temp file (only if path exists)
      if (file.path) {
        try {
          await fs.unlink(file.path);
        } catch (e) {
          // Ignore cleanup errors
        }
      }
    }
  }

  return results;
};

/**
 * Process a single document
 */
const processDocument = async (file, metadata) => {
  const { type, title, textContent } = metadata;

  // Step 1: Extract text from document (or use pre-extracted content for YouTube, etc.)
  console.log(`Extracting text from ${file.originalname}...`);
  let extractedText;
  
  // If textContent is provided in metadata (e.g., from YouTube transcription), use it directly
  if (textContent && typeof textContent === 'string' && textContent.trim().length > 0) {
    console.log(`[ProcessDocument] Using pre-extracted text content (${textContent.length} chars)`);
    extractedText = textContent;
  } else {
    try {
      extractedText = await extractText(file);
    } catch (extractError) {
      console.error(`[ProcessDocument] Extraction failed for ${file.originalname}:`, extractError.message);
      // Re-throw with more context for debugging
      throw new Error(`Failed to extract text from ${file.originalname}: ${extractError.message}`);
    }
  }

  if (!extractedText || extractedText.trim().length === 0) {
    throw new Error('No text could be extracted from document');
  }

  // Check for garbled text and track warning
  let warning = null;
  if (isTextGarbled(extractedText)) {
    console.warn(`WARNING: "${file.originalname}" appears to have garbled text due to custom font encoding.`);
    warning = {
      type: 'garbled_text',
      message: 'This PDF appears to have garbled text due to custom font encoding. The file was uploaded, but search and quiz generation may not work correctly.',
      suggestion: 'Try finding a different version of the PDF with proper text encoding, or re-download from the original source.'
    };
    // Continue processing anyway - the embeddings won't be useful but we'll store the file
  }

  // Step 2: Detect if document is STEM content (math/science/technical)
  const { isSTEM, confidence, indicators } = detectSTEMContent(extractedText);
  console.log(`Document classification: ${isSTEM ? 'STEM' : 'Non-STEM'} (confidence: ${confidence}%, indicators: ${indicators.join(', ') || 'none'})`);

  // Step 3: Extract chapter/topic structure from the document
  console.log('Extracting document structure...');
  const documentStructure = extractDocumentStructure(extractedText);
  console.log(`Found ${documentStructure.chapters.length} chapters, ${documentStructure.totalTopics} topics`);

  // Step 4: Chunk the document
  // Use STEM-aware chunker for technical content, simple chunker for general content
  console.log('Chunking document...');
  const chunker = isSTEM 
    ? new MathAwareChunker({ chunkSize: 1000, chunkOverlap: 200 })
    : new SimpleChunker({ chunkSize: 1000, chunkOverlap: 200 });
  
  const chunks = chunker.chunk(extractedText);
  console.log(`Created ${chunks.length} chunks`);

  // Step 4b: Assign chapter/topic info to each chunk based on position
  assignChapterInfoToChunks(chunks, documentStructure, extractedText);

  // Step 4: Generate embeddings for all chunks
  console.log('Generating embeddings...');
  const chunkTexts = chunks.map(c => c.content);
  // Always use OpenAI for embeddings to match database schema (vector(1536))
  const embeddings = await generateBatchEmbeddings(chunkTexts, {
    hasMath: isSTEM, // Use STEM classification for embedding strategy
    provider: 'openai'
  });

  // Step 5: Perform topic clustering if no chapter structure was found
  // This ensures we always have "chapters" (topics) to show in the UI
  if (!documentStructure.hasStructure && chunks.length > 2) {
    console.log('No chapter structure found. Running AI topic clustering...');
    try {
      // Prepare chunks with embeddings for worker
      // Assign temporary ID to map back
      const chunksWithEmbeddings = chunks.map((c, i) => ({
        ...c,
        embedding: embeddings[i]?.embedding,
        _tempIndex: i
      }));

      // Filter out chunks without embeddings AND noise chunks (bibliography, index, etc.)
      const validChunks = chunksWithEmbeddings.filter(c => {
        if (!c.embedding) return false;
        // Filter out noise chunks
        if (isNoiseChunk(c.content)) {
          c.metadata = c.metadata || {};
          c.metadata.isNoise = true;
          return false;
        }
        return true;
      });

      console.log(`Filtered to ${validChunks.length} valid chunks (excluded ${chunksWithEmbeddings.length - validChunks.length} noise chunks)`);

      if (validChunks.length > 0) {
        const clusters = await clusterChunks(validChunks);
        console.log(`Clustering complete: Found ${clusters.length} clusters`);

        // Convert clusters to "chapters" structure
        documentStructure.hasStructure = true;
        documentStructure.chapters = clusters.map((cluster, i) => {
          // Extract a meaningful topic title from the cluster content
          const { title, description } = extractTopicTitleAndDescription(cluster);

          // Update chunks in the main array with this chapter info
          cluster.chunks.forEach(clusterChunk => {
            if (typeof clusterChunk._tempIndex !== 'undefined') {
              const originalChunk = chunks[clusterChunk._tempIndex];
              if (originalChunk) {
                originalChunk.metadata = originalChunk.metadata || {};
                originalChunk.metadata.chapter = i + 1;
                originalChunk.metadata.chapterTitle = title;
                originalChunk.metadata.chapterDescription = description;
                originalChunk.metadata.isGeneratedTopic = true;
              }
            }
          });

          return {
            number: i + 1,
            title: title,
            description: description,
            chunkCount: cluster.chunks.length,
            topics: [] // Sub-topics could be added here if we did hierarchical clustering
          };
        });
        
        console.log(`Assigned ${documentStructure.chapters.length} generated topics as chapters`);
      }
    } catch (err) {
      console.warn('Topic clustering failed:', err.message);
      // Fallback: Continue without structure
    }
  }

  // Step 6: Store in database using transaction
  const materialId = await transaction(async (client) => {
    // Insert material record with document structure
    const materialMetadata = {
      ...(metadata.extra || {}),
      stemConfidence: confidence,
      stemIndicators: indicators,
      structure: documentStructure // Contains chapters, topics, and their positions
    };
    
    const materialResult = await client.query(
      `INSERT INTO materials (type, title, file_name, total_chunks, has_math, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        type || 'document',
        title || file.originalname,
        file.originalname,
        chunks.length,
        isSTEM, // has_math column now represents STEM content
        JSON.stringify(materialMetadata)
      ]
    );

    const materialId = materialResult.rows[0].id;

    // Insert all chunks
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const embedding = embeddings[i]?.embedding;
      // Sanitize chunk content before storing
      const sanitizedContent = sanitizeText(chunk.content);

      await client.query(
        `INSERT INTO material_chunks 
         (material_id, chunk_index, content, content_type, has_math, embedding, token_count, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          materialId,
          i,
          sanitizedContent,
          chunk.metadata?.contentType || 'text',
          chunk.metadata?.hasMath || false,
          embedding ? `[${embedding.join(',')}]` : null,
          estimateTokenCount(sanitizedContent),
          JSON.stringify(chunk.metadata || {})
        ]
      );
    }

    return materialId;
  });

  return {
    materialId,
    fileName: file.originalname,
    success: true,
    chunksCreated: chunks.length,
    isSTEM,
    stemConfidence: confidence,
    totalCharacters: extractedText.length,
    estimatedTokens: estimateTokenCount(extractedText),
    warning // Include any warnings about the file
  };
};

/**
 * Extract text from file based on extension
 */
const extractText = async (file) => {
  const extension = path.extname(file.originalname).toLowerCase();

  switch (extension) {
    case '.pdf':
      return extractFromPDF(file.path);
    case '.docx':
    case '.doc':
      return extractFromDocx(file.path);
    case '.txt':
    case '.md':
    case '.markdown':
      return extractFromText(file.path);
    case '.tex':
      return extractFromText(file.path); // LaTeX files are plain text
    case '.mp3':
      return extractFromAudio(file.path);
    default:
      // Try to read as text
      return extractFromText(file.path);
  }
};

/**
 * Extract text from PDF
 */
const extractFromPDF = async (filePath) => {
  try {
    const dataBuffer = await fs.readFile(filePath);
    const data = await pdfParse(dataBuffer);
    // Sanitize text: remove null bytes and other problematic characters
    const text = sanitizeText(data.text);
    
    // Check for garbled text (custom font encoding issue)
    if (isTextGarbled(text)) {
      console.warn('PDF appears to use custom font encoding - text may be garbled');
      // Still return the text, but it will be garbled
      // In the future, we could add OCR fallback here
    }
    
    return text;
  } catch (error) {
    throw new Error(`PDF extraction failed: ${error.message}`);
  }
};

/**
 * Detect if extracted text is garbled (custom font encoding)
 * Returns true if text appears to be incorrectly encoded
 */
const isTextGarbled = (text) => {
  if (!text || text.length < 100) return false;
  
  // Sample the first 1000 characters
  const sample = text.substring(0, 1000);
  
  // Count readable vs problematic patterns
  let score = 0;
  
  // Check for common English words (should appear in readable text)
  const commonWords = ['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'with', 'this', 'that', 'from', 'have', 'been'];
  const lowerSample = sample.toLowerCase();
  const foundCommonWords = commonWords.filter(word => lowerSample.includes(word)).length;
  
  // If very few common words found, likely garbled
  if (foundCommonWords < 3) {
    score += 3;
  }
  
  // Check for unusual character sequences (repeated special chars)
  const unusualPatterns = sample.match(/[=\]\[]{2,}|[^a-zA-Z0-9\s.,!?;:'"()-]{3,}/g) || [];
  if (unusualPatterns.length > 10) {
    score += 2;
  }
  
  // Check ratio of special characters to letters
  const letters = (sample.match(/[a-zA-Z]/g) || []).length;
  const specialChars = (sample.match(/[=\]\[@#$%^&*]/g) || []).length;
  if (specialChars > letters * 0.1) {
    score += 2;
  }
  
  return score >= 4;
};

/**
 * Sanitize text for database storage
 * Removes null bytes and other problematic characters
 */
const sanitizeText = (text) => {
  if (!text) return text;
  return text
    // Remove null bytes (causes PostgreSQL UTF-8 errors)
    .replace(/\x00/g, '')
    // Remove other control characters except newlines and tabs
    .replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    // Normalize unicode
    .normalize('NFC');
};

/**
 * Extract text from DOCX
 */
const extractFromDocx = async (filePath) => {
  try {
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
  } catch (error) {
    throw new Error(`DOCX extraction failed: ${error.message}`);
  }
};

/**
 * Extract text from plain text files
 */
const extractFromText = async (filePath) => {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    throw new Error(`Text extraction failed: ${error.message}`);
  }
};

/**
 * Extract text from audio files using Deepgram transcription
 */
const extractFromAudio = async (filePath) => {
  try {
    console.log(`[Audio] Transcribing audio file: ${filePath}`);
    console.log(`[Audio] DEEPGRAM_API_KEY is ${process.env.DEEPGRAM_API_KEY ? 'SET' : 'NOT SET'}`);
    
    // Validate audio file first
    await validateAudioFile(filePath);
    console.log(`[Audio] File validation passed`);
    
    // Transcribe using Deepgram
    const transcript = await transcribeAudio(filePath);
    
    if (!transcript || transcript.trim().length === 0) {
      throw new Error('Audio transcription returned empty text');
    }
    
    console.log(`[Audio] Transcription complete: ${transcript.length} characters`);
    return transcript;
  } catch (error) {
    console.error('[Audio] Transcription error:', error.message);
    console.error('[Audio] Full error:', error);
    // Include more debugging info in the error message
    const debugInfo = process.env.DEEPGRAM_API_KEY ? 'API key is set' : 'API key is MISSING';
    throw new Error(`Audio transcription failed (${debugInfo}): ${error.message}`);
  }
};

/**
 * Detect if a chunk is "noise" - bibliography, index, table of contents, front matter
 * These should be excluded from topic clustering
 * 
 * @param {string} content - Chunk content
 * @returns {boolean} - True if chunk appears to be noise
 */
const isNoiseChunk = (content) => {
  if (!content || content.length < 50) return true;
  
  const text = content.toLowerCase();
  const lines = content.split('\n').filter(l => l.trim());
  
  // Index detection: lots of page number references like "23, 26–34, 37–8"
  const pageNumberPattern = /\d+[–-]\d+|\b\d{1,3}(?:\s*,\s*\d{1,3}){2,}/g;
  const pageNumberMatches = content.match(pageNumberPattern) || [];
  if (pageNumberMatches.length >= 5) {
    return true; // Likely an index
  }
  
  // Bibliography detection: author names with years in parentheses "(2018)", "(ed.)", "Press,"
  const bibPatterns = [
    /\(\d{4}\)/g,                    // (2018)
    /\(ed\.?\)/gi,                   // (ed.) or (ed)
    /University Press/gi,            // Publisher names
    /\bPress,\s+\d{4}/gi,           // Press, 2018
    /\bpp\.\s*\d+/gi,               // pp. 123
    /ISBN/gi,                        // ISBN numbers
    /\bet\s+al\./gi,                // et al.
  ];
  
  let bibScore = 0;
  for (const pattern of bibPatterns) {
    const matches = content.match(pattern) || [];
    bibScore += matches.length;
  }
  
  if (bibScore >= 5) {
    return true; // Likely bibliography/references
  }
  
  // Front matter detection: copyright, edition info, etc.
  const frontMatterKeywords = [
    'copyright', 'all rights reserved', 'isbn', 'printed in',
    'first published', 'edition', 'cataloging-in-publication',
    'library of congress', 'british library', 'typeset'
  ];
  
  let frontMatterScore = 0;
  for (const keyword of frontMatterKeywords) {
    if (text.includes(keyword)) frontMatterScore++;
  }
  
  if (frontMatterScore >= 3) {
    return true; // Likely front matter
  }
  
  // Table of contents detection: many short lines with page numbers
  const tocPattern = /^.{5,60}\s+\d{1,3}\s*$/gm;
  const tocMatches = content.match(tocPattern) || [];
  if (tocMatches.length >= 5 && tocMatches.length / lines.length > 0.5) {
    return true; // Likely table of contents
  }
  
  // Book list detection: "SERIES" or list of book titles
  if (text.includes('series') && (text.match(/\b[A-Z]{2,}\b/g) || []).length > 10) {
    return true; // Likely a series/book listing
  }
  
  return false;
};

/**
 * Extract a meaningful title and description from a topic cluster
 * Looks for the most representative and descriptive content
 * 
 * @param {Object} cluster - Cluster with chunks and centroid
 * @returns {{ title: string, description: string }}
 */
const extractTopicTitleAndDescription = (cluster) => {
  if (!cluster.chunks || cluster.chunks.length === 0) {
    return { title: 'Unknown Topic', description: '' };
  }
  
  // Collect all content from the cluster
  const allContent = cluster.chunks.map(c => c.content).join('\n\n');
  
  // Try to find a good title from headers or key phrases
  let title = '';
  
  // Look for capitalized phrases that might be section headers
  const headerPatterns = [
    /^([A-Z][A-Z\s]{5,50})$/gm,                    // ALL CAPS headers
    /^(?:The\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,5})$/gm,  // Title Case headers
    /^(?:\d+\.?\s*)?([A-Z][a-z]+(?:\s+(?:of|the|and|in|to|for|a|an)\s+)?[A-Z]?[a-z]+(?:\s+[A-Z]?[a-z]+){0,4})$/gm, // Numbered sections
  ];
  
  for (const pattern of headerPatterns) {
    const matches = allContent.match(pattern);
    if (matches && matches.length > 0) {
      // Find the most common header (likely the main topic)
      const headerCounts = {};
      matches.forEach(h => {
        const cleaned = h.trim().replace(/^\d+\.?\s*/, '');
        if (cleaned.length >= 5 && cleaned.length <= 60) {
          headerCounts[cleaned] = (headerCounts[cleaned] || 0) + 1;
        }
      });
      
      const sortedHeaders = Object.entries(headerCounts).sort((a, b) => b[1] - a[1]);
      if (sortedHeaders.length > 0) {
        title = sortedHeaders[0][0];
        break;
      }
    }
  }
  
  // If no header found, extract key noun phrases
  if (!title) {
    // Look for frequently mentioned proper nouns or key terms
    const properNouns = allContent.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b/g) || [];
    const nounCounts = {};
    
    properNouns.forEach(noun => {
      // Skip common words and short terms
      const lower = noun.toLowerCase();
      if (noun.length >= 4 && 
          !['The', 'This', 'That', 'These', 'Those', 'They', 'There', 'What', 'When', 'Where', 'Which', 'While', 'With', 'From', 'Into', 'About', 'After', 'Before', 'During'].includes(noun)) {
        nounCounts[noun] = (nounCounts[noun] || 0) + 1;
      }
    });
    
    const sortedNouns = Object.entries(nounCounts)
      .filter(([noun, count]) => count >= 2) // Must appear at least twice
      .sort((a, b) => b[1] - a[1]);
    
    if (sortedNouns.length > 0) {
      // Take top 2-3 key terms
      const topTerms = sortedNouns.slice(0, 3).map(([noun]) => noun);
      title = topTerms.join(', ');
    }
  }
  
  // Fallback: use first meaningful sentence fragment
  if (!title) {
    const firstChunk = cluster.chunks[0];
    const sentences = firstChunk.content.match(/[A-Z][^.!?\n]{15,80}[.!?]/g) || [];
    if (sentences.length > 0) {
      title = sentences[0].substring(0, 60);
      if (title.length === 60) title += '...';
    } else {
      title = 'Topic Content';
    }
  }
  
  // Clean up title
  title = title.trim().replace(/\s+/g, ' ');
  if (title.length > 70) {
    title = title.substring(0, 67) + '...';
  }
  
  // Extract description from the most representative chunk
  let description = '';
  if (cluster.centroid) {
    let bestChunk = null;
    let bestSim = -1;
    
    cluster.chunks.forEach(c => {
      if (c.embedding) {
        const sim = cosineSimilarity(c.embedding, cluster.centroid);
        if (sim > bestSim) {
          bestSim = sim;
          bestChunk = c;
        }
      }
    });
    
    if (bestChunk && bestChunk.content) {
      // Extract a meaningful sentence that describes the topic
      const sentences = bestChunk.content.match(/[A-Z][^.!?\n]{30,150}[.!?]/g) || [];
      if (sentences.length > 0) {
        // Find a sentence that's descriptive (not just a fragment)
        const descriptive = sentences.find(s => 
          s.includes(' is ') || s.includes(' are ') || s.includes(' was ') || 
          s.includes(' were ') || s.includes(' became ') || s.includes(' developed ')
        );
        description = descriptive || sentences[0];
      }
    }
  }
  
  return { title, description };
};

/**
 * Extract chapter and topic structure from document text
 * Identifies chapters, sections, and their approximate positions for balanced question distribution
 * 
 * @param {string} text - Full document text
 * @returns {{ chapters: Array, totalTopics: number }}
 */
const extractDocumentStructure = (text) => {
  const chapters = [];
  const topicSet = new Set();
  
  // Chapter patterns (ordered by specificity)
  const chapterPatterns = [
    // "Chapter 1: Title" or "Chapter 1 Title" or "CHAPTER 1"
    /^(?:Chapter|CHAPTER)\s+(\d+)(?:\s*[:.]\s*|\s+)(.+?)$/gim,
    // "Part 1: Title"
    /^(?:Part|PART)\s+(\d+)(?:\s*[:.]\s*|\s+)(.+?)$/gim,
    // "Unit 1: Title"
    /^(?:Unit|UNIT)\s+(\d+)(?:\s*[:.]\s*|\s+)(.+?)$/gim,
    // "Module 1: Title"
    /^(?:Module|MODULE)\s+(\d+)(?:\s*[:.]\s*|\s+)(.+?)$/gim,
    // Numbered sections like "1. Introduction" at start of line
    /^(\d+)\.\s+([A-Z][^.!?\n]{3,60})$/gim,
    // Markdown headers "# Title" or "## Title"
    /^(#{1,2})\s+(.+?)$/gim,
  ];

  // Section/topic patterns (within chapters)
  const sectionPatterns = [
    // "Section 1.2: Title" or "1.2 Title"
    /^(?:Section\s+)?(\d+\.\d+(?:\.\d+)?)\s*[:.]\s*(.+?)$/gim,
    // "### Subsection" markdown
    /^(#{3,4})\s+(.+?)$/gim,
    // Bold or emphasized headings "**Topic**"
    /^\*\*([^*]+)\*\*$/gim,
  ];

  // Extract chapters with their positions
  for (const pattern of chapterPatterns) {
    let match;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(text)) !== null) {
      const chapterNum = match[1].startsWith('#') ? chapters.length + 1 : parseInt(match[1]) || chapters.length + 1;
      const title = match[2]?.trim() || `Chapter ${chapterNum}`;
      
      // Avoid duplicate chapter numbers
      if (!chapters.find(c => c.number === chapterNum)) {
        chapters.push({
          number: chapterNum,
          title: title.substring(0, 100), // Limit title length
          position: match.index,
          endPosition: null, // Will be calculated later
          topics: [],
          chunkCount: 0
        });
      }
    }
  }

  // Sort chapters by position in text
  chapters.sort((a, b) => a.position - b.position);

  // Calculate end positions (start of next chapter or end of text)
  for (let i = 0; i < chapters.length; i++) {
    chapters[i].endPosition = (i < chapters.length - 1) 
      ? chapters[i + 1].position 
      : text.length;
  }

  // Extract topics within each chapter
  for (const chapter of chapters) {
    const chapterText = text.substring(chapter.position, chapter.endPosition);
    
    for (const pattern of sectionPatterns) {
      let match;
      pattern.lastIndex = 0;
      while ((match = pattern.exec(chapterText)) !== null) {
        const topicTitle = match[2]?.trim() || match[1]?.trim();
        if (topicTitle && topicTitle.length > 2 && topicTitle.length < 100) {
          chapter.topics.push({
            title: topicTitle,
            position: chapter.position + match.index
          });
          topicSet.add(topicTitle.toLowerCase());
        }
      }
    }
  }

  // If no chapters found, create a single "virtual" chapter
  /* 
  // Disabled "Main Content" fallback to allow topic clustering in quiz generator
  if (chapters.length === 0) {
    chapters.push({
      number: 1,
      title: 'Main Content',
      position: 0,
      endPosition: text.length,
      topics: [],
      chunkCount: 0
    });
  }
  */

  return {
    chapters,
    totalTopics: topicSet.size,
    hasStructure: chapters.length > 1 || chapters[0]?.topics?.length > 0
  };
};

/**
 * Assign chapter and topic info to chunks based on their position in the original text
 * 
 * @param {Array} chunks - Array of chunk objects
 * @param {Object} structure - Document structure from extractDocumentStructure
 * @param {string} originalText - Original document text
 */
const assignChapterInfoToChunks = (chunks, structure, originalText) => {
  // Build a position map to find where each chunk appears in the original text
  let searchPosition = 0;
  
  for (const chunk of chunks) {
    // Find the chunk's approximate position in the original text
    const chunkStart = chunk.content.substring(0, 50);
    const position = originalText.indexOf(chunkStart, searchPosition);
    
    if (position !== -1) {
      searchPosition = position;
      
      // Find which chapter this position falls into
      for (const chapter of structure.chapters) {
        if (position >= chapter.position && position < chapter.endPosition) {
          chunk.metadata = chunk.metadata || {};
          chunk.metadata.chapter = chapter.number;
          chunk.metadata.chapterTitle = chapter.title;
          chapter.chunkCount = (chapter.chunkCount || 0) + 1;
          
          // Find topic if any
          const chunkTopics = chapter.topics.filter(t => 
            position >= t.position && position < (chapter.endPosition)
          );
          if (chunkTopics.length > 0) {
            chunk.metadata.topic = chunkTopics[chunkTopics.length - 1].title;
          }
          break;
        }
      }
    }
  }
  
  // Log chapter distribution
  const distribution = structure.chapters.map(c => `Ch${c.number}: ${c.chunkCount} chunks`).join(', ');
  console.log(`[Structure] Chunk distribution: ${distribution}`);
};

/**
 * Detect if document is STEM content (math, science, engineering, technical)
 * Uses density-based analysis rather than simple presence detection
 * Returns classification with confidence score
 * 
 * @param {string} text - Document text
 * @returns {{ isSTEM: boolean, confidence: number, indicators: string[] }}
 */
const detectSTEMContent = (text) => {
  if (!text || text.length < 100) {
    return { isSTEM: false, confidence: 0, indicators: [] };
  }

  const textLength = text.length;
  const sampleSize = Math.min(textLength, 50000); // Sample first 50k chars for performance
  const sample = text.substring(0, sampleSize);
  const indicators = [];
  let score = 0;

  // ============================================
  // TIER 1: Strong LaTeX indicators (definitive)
  // These are unambiguous math/science markers
  // ============================================
  const strongLatexPatterns = {
    'LaTeX display math': /\$\$[\s\S]{5,}?\$\$/g,           // $$...$$ with actual content
    'LaTeX equation env': /\\begin\{(equation|align|gather|eqnarray)\*?\}/gi,
    'LaTeX math operators': /\\(?:frac|sqrt|sum|int|prod|lim|partial)\{/g,
    'LaTeX matrix': /\\begin\{(matrix|bmatrix|pmatrix|vmatrix)\}/gi,
  };

  for (const [name, pattern] of Object.entries(strongLatexPatterns)) {
    const matches = sample.match(pattern) || [];
    if (matches.length >= 2) {
      score += 30;
      indicators.push(name);
    } else if (matches.length === 1) {
      score += 15;
    }
  }

  // ============================================
  // TIER 2: Unicode math symbols (strong)
  // Count actual occurrences, require density
  // ============================================
  const mathSymbolPattern = /[∑∫∏∂∇∆√∛∜∞∝≈≠≡≤≥±×÷·∀∃∈∉⊂⊃⊆⊇∪∩∅→←↔⇒⇐⇔↦∧∨¬⊕⊗ℕℤℚℝℂℙ]/g;
  const mathSymbolMatches = sample.match(mathSymbolPattern) || [];
  const mathSymbolDensity = (mathSymbolMatches.length / sampleSize) * 10000; // per 10k chars
  
  if (mathSymbolDensity > 10) {
    score += 25;
    indicators.push('math symbols (high density)');
  } else if (mathSymbolDensity > 3) {
    score += 15;
    indicators.push('math symbols');
  }

  // Greek letters in technical context (not just alpha/beta used in general text)
  const greekPattern = /[γδεζηθικλμνξπρστυφχψωΓΔΘΛΞΠΣΦΨΩ]/g;
  const greekMatches = sample.match(greekPattern) || [];
  const greekDensity = (greekMatches.length / sampleSize) * 10000;
  
  if (greekDensity > 5) {
    score += 20;
    indicators.push('Greek letters (high density)');
  } else if (greekDensity > 2) {
    score += 10;
    indicators.push('Greek letters');
  }

  // ============================================
  // TIER 3: Mathematical notation patterns
  // More sophisticated pattern matching
  // ============================================
  
  // Function notation: f(x), g(t), h(n) in isolation (not words like "of(x")
  const functionNotation = sample.match(/\b[fghFGH]\s*\(\s*[a-zA-Z]\s*\)/g) || [];
  if (functionNotation.length >= 5) {
    score += 15;
    indicators.push('function notation');
  }

  // Subscript notation: x_1, a_n, etc. (common in math/science)
  const subscriptNotation = sample.match(/\b[a-zA-Z]_\{?[0-9ijn]\}?/g) || [];
  if (subscriptNotation.length >= 10) {
    score += 15;
    indicators.push('subscript notation');
  }

  // Superscript/exponent notation: x^2, n^3, e^{-x}
  const exponentNotation = sample.match(/\b[a-zA-Z]\^\{?[\-0-9a-z]+\}?/g) || [];
  if (exponentNotation.length >= 10) {
    score += 15;
    indicators.push('exponent notation');
  }

  // ============================================
  // TIER 4: STEM terminology density
  // Look for clusters of technical terms, not isolated occurrences
  // ============================================
  
  // Hard STEM terms (rarely used outside technical contexts)
  const hardStemTerms = /\b(eigenvalue|eigenvector|determinant|Jacobian|Hessian|Laplacian|Hamiltonian|polynomial|differential|logarithm|exponential|asymptotic|convergence|divergence|homeomorphism|isomorphism|bijection|surjection|injection|cardinality|countable|uncountable|topology|manifold|Hilbert|Banach|Lebesgue|Fourier|Laplace|Riemannian|Euclidean|Cartesian|orthogonal|orthonormal|diagonalizable)\b/gi;
  const hardStemMatches = sample.match(hardStemTerms) || [];
  if (hardStemMatches.length >= 5) {
    score += 25;
    indicators.push('advanced math terminology');
  } else if (hardStemMatches.length >= 2) {
    score += 12;
    indicators.push('math terminology');
  }

  // Science/engineering terms
  const scienceTerms = /\b(quantum|photon|electron|proton|neutron|molecule|polymer|catalyst|thermodynamic|entropy|enthalpy|kinetics|electromagnetic|semiconductor|transistor|algorithm|complexity|optimization|iteration|recursion|convergence|numerical|computational|simulation|stochastic|probabilistic|Gaussian|Poisson|Bayesian|regression|correlation|variance|covariance|eigenmode|wavefunction|Schrödinger|Maxwell|Boltzmann)\b/gi;
  const scienceMatches = sample.match(scienceTerms) || [];
  if (scienceMatches.length >= 5) {
    score += 20;
    indicators.push('science/engineering terminology');
  } else if (scienceMatches.length >= 2) {
    score += 10;
  }

  // ============================================
  // TIER 5: Structural patterns (weaker signals)
  // These can appear in non-STEM but are suggestive
  // ============================================

  // Theorem/Lemma/Proof structure with numbers
  const theoremStructure = sample.match(/\b(Theorem|Lemma|Corollary|Proposition)\s+\d+(\.\d+)*/gi) || [];
  if (theoremStructure.length >= 3) {
    score += 15;
    indicators.push('theorem structure');
  }

  // Definition with formal structure
  const definitionStructure = sample.match(/\bDefinition\s+\d+(\.\d+)*\s*[.:]/gi) || [];
  if (definitionStructure.length >= 3) {
    score += 12;
    indicators.push('formal definitions');
  }

  // ============================================
  // NEGATIVE SIGNALS: Reduce score for non-STEM content
  // ============================================
  
  // Architecture/design terms (reduce false positives)
  const archTerms = /\b(architect|architecture|building|facade|floor\s*plan|elevation|blueprint|construction|aesthetic|design\s*principle|urban|landscape|interior|renovation|preservation|modernist|postmodern|gothic|baroque|renaissance|neoclassical|brutalist|contemporary|residential|commercial|zoning|setback|footprint|cantilever|fenestration)\b/gi;
  const archMatches = sample.match(archTerms) || [];
  if (archMatches.length >= 5) {
    score -= 15;
    // Remove STEM classification if document is clearly architecture-focused
    if (archMatches.length >= 15 && score < 50) {
      score = Math.min(score, 20);
    }
  }

  // Literature/humanities terms
  const humanitiesTerms = /\b(narrative|protagonist|metaphor|allegory|symbolism|rhetoric|discourse|epistemology|ontology|phenomenology|hermeneutic|poststructural|deconstruction|semiotics|dialectic|aesthetic|sublime|tragic|comic|irony|satire)\b/gi;
  const humanitiesMatches = sample.match(humanitiesTerms) || [];
  if (humanitiesMatches.length >= 5) {
    score -= 10;
  }

  // ============================================
  // Calculate final classification
  // ============================================
  
  // Normalize score to confidence percentage (0-100)
  const confidence = Math.min(100, Math.max(0, score));
  
  // Threshold: require confidence >= 40 for STEM classification
  // This means we need substantial evidence, not just a few scattered patterns
  const isSTEM = confidence >= 40;

  return { isSTEM, confidence, indicators };
};

/**
 * Get material by ID with chunks
 */
export const getMaterialWithChunks = async (materialId) => {
  const materialResult = await query(
    `SELECT * FROM materials WHERE id = $1`,
    [materialId]
  );

  if (materialResult.rows.length === 0) {
    return null;
  }

  const chunksResult = await query(
    `SELECT id, chunk_index, content, content_type, has_math, metadata
     FROM material_chunks 
     WHERE material_id = $1 
     ORDER BY chunk_index`,
    [materialId]
  );

  return {
    ...materialResult.rows[0],
    chunks: chunksResult.rows
  };
};

/**
 * Get all materials
 */
export const getAllMaterials = async () => {
  const result = await query(
    `SELECT id, type, title, file_name, total_chunks, has_math, created_at
     FROM materials 
     ORDER BY created_at DESC`
  );

  return result.rows;
};

/**
 * Delete material and its chunks
 */
export const deleteMaterial = async (materialId) => {
  await query('DELETE FROM materials WHERE id = $1', [materialId]);
  return true;
};

/**
 * Update material chunk embeddings (for re-embedding with different provider)
 */
export const reembedMaterial = async (materialId, options = {}) => {
  const material = await getMaterialWithChunks(materialId);
  
  if (!material) {
    throw new Error('Material not found');
  }

  const chunkTexts = material.chunks.map(c => c.content);
  const embeddings = await generateBatchEmbeddings(chunkTexts, {
    hasMath: material.has_math,
    ...options
  });

  await transaction(async (client) => {
    for (let i = 0; i < material.chunks.length; i++) {
      const chunk = material.chunks[i];
      const embedding = embeddings[i]?.embedding;

      if (embedding) {
        await client.query(
          `UPDATE material_chunks SET embedding = $1 WHERE id = $2`,
          [`[${embedding.join(',')}]`, chunk.id]
        );
      }
    }
  });

  return { updated: material.chunks.length };
};

/**
 * Cluster chunks by topic using worker thread
 */
const clusterChunks = (chunks) => {
  return new Promise((resolve, reject) => {
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
      numClusters: 6, // Default target
      minChunksPerGroup: 1
    });
  });
};

export default {
  processAndStoreDocuments,
  getMaterialWithChunks,
  getAllMaterials,
  deleteMaterial,
  reembedMaterial
};
