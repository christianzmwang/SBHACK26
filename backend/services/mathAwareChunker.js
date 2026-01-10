/**
 * Math-Aware Text Chunker
 * 
 * Intelligently chunks text while preserving:
 * - Mathematical equations (inline $...$ and display $$...$$)
 * - LaTeX environments (\begin{...}...\end{...})
 * - Theorem/Definition/Proof blocks
 * - Code blocks
 * - Section structure
 */

export class MathAwareChunker {
  constructor(options = {}) {
    this.chunkSize = options.chunkSize || 1000; // Target chunk size in characters
    this.chunkOverlap = options.chunkOverlap || 200; // Overlap between chunks
    this.minChunkSize = options.minChunkSize || 100; // Minimum chunk size
    this.preserveStructure = options.preserveStructure !== false;
  }

  /**
   * Main chunking method
   * @param {string} text - The text to chunk
   * @returns {Array<{content: string, metadata: object}>} - Array of chunks with metadata
   */
  chunk(text) {
    if (!text || typeof text !== 'string') {
      return [];
    }

    // Step 1: Protect special blocks from being split
    const { protectedText, protectedBlocks } = this.protectSpecialBlocks(text);

    // Step 2: Split by semantic boundaries (sections, paragraphs)
    const rawChunks = this.splitBySections(protectedText);

    // Step 3: Further split large chunks while respecting boundaries
    const sizedChunks = this.splitLargeChunks(rawChunks);

    // Step 4: Restore protected blocks and add metadata
    const finalChunks = sizedChunks.map((chunk, index) => {
      const restoredContent = this.restoreProtectedBlocks(chunk.content, protectedBlocks);
      const metadata = this.extractMetadata(restoredContent, chunk);
      
      return {
        content: restoredContent,
        chunkIndex: index,
        metadata: {
          ...metadata,
          ...chunk.metadata,
          hasMath: this.containsMath(restoredContent),
          wordCount: restoredContent.split(/\s+/).length,
          charCount: restoredContent.length
        }
      };
    });

    return finalChunks.filter(chunk => chunk.content.trim().length >= this.minChunkSize);
  }

  /**
   * Protect special blocks that shouldn't be split
   */
  protectSpecialBlocks(text) {
    const protectedBlocks = [];
    let index = 0;
    let protectedText = text;

    // Define protection patterns in order of priority
    const patterns = [
      // Display math: $$...$$
      {
        regex: /\$\$[\s\S]*?\$\$/g,
        type: 'display_math'
      },
      // LaTeX environments
      {
        regex: /\\begin\{(equation|align|gather|matrix|bmatrix|pmatrix|cases|array|eqnarray)\*?\}[\s\S]*?\\end\{\1\*?\}/g,
        type: 'latex_env'
      },
      // Theorem-like environments
      {
        regex: /\\begin\{(theorem|definition|lemma|proposition|corollary|proof|example|remark|note)\*?\}[\s\S]*?\\end\{\1\*?\}/g,
        type: 'theorem_env'
      },
      // Code blocks (markdown)
      {
        regex: /```[\s\S]*?```/g,
        type: 'code_block'
      },
      // Inline math: $...$ (but not $$)
      {
        regex: /(?<!\$)\$(?!\$)([^$\n]+?)\$(?!\$)/g,
        type: 'inline_math'
      },
      // LaTeX inline math: \(...\)
      {
        regex: /\\\([\s\S]*?\\\)/g,
        type: 'inline_math'
      },
      // LaTeX display math: \[...\]
      {
        regex: /\\\[[\s\S]*?\\\]/g,
        type: 'display_math'
      }
    ];

    for (const { regex, type } of patterns) {
      protectedText = protectedText.replace(regex, (match) => {
        const placeholder = `<<PROTECTED_${type.toUpperCase()}_${index}>>`;
        protectedBlocks.push({
          placeholder,
          content: match,
          type
        });
        index++;
        return placeholder;
      });
    }

    return { protectedText, protectedBlocks };
  }

  /**
   * Split text by section boundaries
   */
  splitBySections(text) {
    const chunks = [];
    
    // Define section patterns
    const sectionPatterns = [
      // Markdown headers
      /(?=^#{1,6}\s+.+$)/gm,
      // LaTeX sections
      /(?=\\(?:chapter|section|subsection|subsubsection)\{)/g,
      // Numbered sections (e.g., "1.2 Introduction")
      /(?=^(?:\d+\.)+\d*\s+[A-Z])/gm,
      // Common textbook headers
      /(?=^(?:Chapter|Section|Part|Unit|Module|Lesson|Exercise|Example|Problem|Solution|Theorem|Definition|Lemma|Proof|Corollary|Proposition)\s+\d*)/gim,
    ];

    // Try to split by sections first
    let sections = [text];
    for (const pattern of sectionPatterns) {
      const newSections = [];
      for (const section of sections) {
        const splits = section.split(pattern).filter(s => s.trim());
        newSections.push(...splits);
      }
      if (newSections.length > sections.length) {
        sections = newSections;
      }
    }

    // Convert to chunk objects with metadata extraction
    for (const section of sections) {
      const sectionMeta = this.extractSectionMetadata(section);
      chunks.push({
        content: section.trim(),
        metadata: sectionMeta
      });
    }

    return chunks;
  }

  /**
   * Split large chunks while respecting paragraph boundaries
   */
  splitLargeChunks(chunks) {
    const result = [];

    for (const chunk of chunks) {
      if (chunk.content.length <= this.chunkSize) {
        result.push(chunk);
        continue;
      }

      // Split by paragraphs (double newlines)
      const paragraphs = chunk.content.split(/\n\n+/);
      let currentChunk = {
        content: '',
        metadata: { ...chunk.metadata }
      };

      for (const para of paragraphs) {
        const trimmedPara = para.trim();
        if (!trimmedPara) continue;

        // Check if adding this paragraph exceeds chunk size
        const potentialSize = currentChunk.content.length + trimmedPara.length + 2;

        if (potentialSize > this.chunkSize && currentChunk.content.length > this.minChunkSize) {
          // Save current chunk
          result.push(currentChunk);

          // Start new chunk with overlap (last few sentences)
          const overlapText = this.getOverlapText(currentChunk.content);
          currentChunk = {
            content: overlapText + '\n\n' + trimmedPara,
            metadata: { ...chunk.metadata }
          };
        } else {
          // Add to current chunk
          currentChunk.content += (currentChunk.content ? '\n\n' : '') + trimmedPara;
        }
      }

      // Don't forget the last chunk
      if (currentChunk.content.trim().length >= this.minChunkSize) {
        result.push(currentChunk);
      }
    }

    return result;
  }

  /**
   * Get overlap text from end of chunk
   */
  getOverlapText(text) {
    if (this.chunkOverlap === 0) return '';

    // Try to get last N characters but break at sentence boundary
    const endPortion = text.slice(-this.chunkOverlap * 2);
    const sentences = endPortion.split(/(?<=[.!?])\s+/);
    
    let overlap = '';
    for (let i = sentences.length - 1; i >= 0; i--) {
      if ((overlap + sentences[i]).length <= this.chunkOverlap) {
        overlap = sentences[i] + (overlap ? ' ' + overlap : '');
      } else {
        break;
      }
    }

    return overlap || endPortion.slice(-this.chunkOverlap);
  }

  /**
   * Restore protected blocks
   */
  restoreProtectedBlocks(text, protectedBlocks) {
    let restored = text;
    for (const { placeholder, content } of protectedBlocks) {
      restored = restored.split(placeholder).join(content);
    }
    return restored;
  }

  /**
   * Extract section metadata from text
   */
  extractSectionMetadata(text) {
    const metadata = {};

    // Try to extract chapter number
    const chapterMatch = text.match(/(?:Chapter|Ch\.?)\s*(\d+)/i);
    if (chapterMatch) {
      metadata.chapter = parseInt(chapterMatch[1]);
    }

    // Try to extract section number
    const sectionMatch = text.match(/(?:Section|§)\s*(\d+(?:\.\d+)*)/i);
    if (sectionMatch) {
      metadata.section = sectionMatch[1];
    }

    // Try to extract section title
    const titleMatch = text.match(/^(?:#{1,6}\s*|\\(?:section|subsection)\{)(.+?)(?:\}|$)/m);
    if (titleMatch) {
      metadata.title = titleMatch[1].trim();
    }

    // Detect content type
    if (/\\begin\{theorem\}/i.test(text) || /^Theorem\s+\d/im.test(text)) {
      metadata.contentType = 'theorem';
    } else if (/\\begin\{definition\}/i.test(text) || /^Definition\s+\d/im.test(text)) {
      metadata.contentType = 'definition';
    } else if (/\\begin\{proof\}/i.test(text) || /^Proof[.:]/im.test(text)) {
      metadata.contentType = 'proof';
    } else if (/\\begin\{example\}/i.test(text) || /^Example\s+\d/im.test(text)) {
      metadata.contentType = 'example';
    } else if (/^Exercise\s+\d/im.test(text) || /^Problem\s+\d/im.test(text)) {
      metadata.contentType = 'exercise';
    }

    return metadata;
  }

  /**
   * Extract metadata from chunk content
   */
  extractMetadata(content, chunk) {
    const metadata = {};

    // Extract key concepts (simple heuristic)
    const boldTerms = content.match(/\*\*([^*]+)\*\*/g) || [];
    const emphTerms = content.match(/\*([^*]+)\*/g) || [];
    const definedTerms = content.match(/(?:defined as|is called|known as)\s+["']?(\w+)/gi) || [];

    const keyConcepts = [...new Set([
      ...boldTerms.map(t => t.replace(/\*\*/g, '')),
      ...emphTerms.map(t => t.replace(/\*/g, '')),
      ...definedTerms.map(t => t.split(/\s+/).pop())
    ])].slice(0, 10);

    if (keyConcepts.length > 0) {
      metadata.keyConcepts = keyConcepts;
    }

    // Detect if chunk contains equations
    metadata.hasEquations = /\$.*?\$|\\begin\{equation\}|\\begin\{align\}/.test(content);

    // Detect if chunk contains code
    metadata.hasCode = /```|\\begin\{verbatim\}|\\begin\{lstlisting\}/.test(content);

    return metadata;
  }

  /**
   * Check if text contains mathematical content
   */
  containsMath(text) {
    const mathPatterns = [
      /\$.*?\$/,                    // Inline math
      /\$\$[\s\S]*?\$\$/,          // Display math
      /\\begin\{equation/,          // LaTeX equation
      /\\begin\{align/,             // LaTeX align
      /\\\[[\s\S]*?\\\]/,          // LaTeX display
      /\\\([\s\S]*?\\\)/,          // LaTeX inline
      /\\frac\{/,                   // Fractions
      /\\sum|\\int|\\prod/,         // Operators
      /\\alpha|\\beta|\\gamma/,     // Greek letters
      /\\mathbb|\\mathcal/,         // Math fonts
    ];

    return mathPatterns.some(pattern => pattern.test(text));
  }
}

/**
 * Simple chunker for non-math content
 */
export class SimpleChunker {
  constructor(options = {}) {
    this.chunkSize = options.chunkSize || 1000;
    this.chunkOverlap = options.chunkOverlap || 200;
  }

  chunk(text) {
    if (!text) return [];

    const chunks = [];
    const paragraphs = text.split(/\n\n+/);
    let currentChunk = '';

    for (const para of paragraphs) {
      if ((currentChunk + para).length > this.chunkSize && currentChunk) {
        chunks.push({
          content: currentChunk.trim(),
          chunkIndex: chunks.length,
          metadata: {
            hasMath: false,
            wordCount: currentChunk.split(/\s+/).length
          }
        });

        // Overlap
        const words = currentChunk.split(' ');
        currentChunk = words.slice(-30).join(' ') + '\n\n' + para;
      } else {
        currentChunk += (currentChunk ? '\n\n' : '') + para;
      }
    }

    if (currentChunk.trim()) {
      chunks.push({
        content: currentChunk.trim(),
        chunkIndex: chunks.length,
        metadata: {
          hasMath: false,
          wordCount: currentChunk.split(/\s+/).length
        }
      });
    }

    return chunks;
  }
}

/**
 * Factory function to get appropriate chunker
 */
export const getChunker = (options = {}) => {
  if (options.mathAware !== false) {
    return new MathAwareChunker(options);
  }
  return new SimpleChunker(options);
};

export default { MathAwareChunker, SimpleChunker, getChunker };
