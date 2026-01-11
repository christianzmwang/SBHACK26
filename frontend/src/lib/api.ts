/**
 * API Service Layer
 * 
 * Handles all communication with the backend
 */

const API_BASE = '/api';

// Direct backend URL for long-running operations (bypasses Next.js proxy timeout)
const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
const BACKEND_API = `${BACKEND_URL}/api`;

// Types
export interface Material {
  id: string;
  type: string;
  title: string;
  file_name: string;
  total_chunks: number;
  has_math: boolean;
  created_at: string;
}

export interface Question {
  id: string;
  question_index: number;
  question: string;
  question_type: string;
  options: Record<string, string>;
  correct_answer?: string;
  correctAnswer?: string; // Backend may return either format
  explanation: string;
  difficulty: string;
  topic?: string;
  chapter?: number;
}

export interface Quiz {
  id: string;
  name: string;
  total_questions: number;
  chapters_covered: number[];
  difficulty: string;
  syllabus_aligned: boolean;
  created_at: string;
  best_score?: number;
  questions?: Question[];
}

export interface Flashcard {
  id: string;
  front: string;
  back: string;
  topic?: string;
  chapter?: number;
  // Alternative properties that may come from LLM generation
  question?: string;
  explanation?: string;
}

export interface FlashcardSet {
  id: string;
  name: string;
  total_cards: number;
  chapters_covered: number[];
  created_at: string;
  mastery_count?: number;
  cards?: Flashcard[];
}

// Material Structure Types (for chapter/topic selection)
export interface MaterialChapter {
  number: number;
  title: string;
  description?: string;
  isGeneratedTopic?: boolean;
  chunkCount: number;
  percentage: string;
  topics: string[];
}

export interface MaterialTopicSummary {
  totalChunks: number;
  embeddedChunks: number;
  estimatedClusters: number;
  topics: string[];
  message: string;
}

export interface MaterialStructure {
  id: string;
  title: string;
  fileName: string;
  totalChunks: number;
  hasChapters: boolean;
  chapters: MaterialChapter[];
  topicSummary?: MaterialTopicSummary;
}

export interface SectionStructure {
  materials: MaterialStructure[];
  totalChunks: number;
  materialsWithChapters: number;
  totalMaterials: number;
}

// API Error handling
class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new ApiError(response.status, error.error || 'Request failed');
  }
  return response.json();
}

// Retry helper for intermittent failures (database cold starts, network issues)
async function withRetry<T>(
  fn: () => Promise<T>,
  options: { maxRetries?: number; delayMs?: number; backoff?: boolean } = {}
): Promise<T> {
  const { maxRetries = 3, delayMs = 500, backoff = true } = options;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      
      // Don't retry on client errors (4xx) - only server/network errors
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
        throw err;
      }
      
      if (attempt < maxRetries - 1) {
        const delay = backoff ? delayMs * Math.pow(2, attempt) : delayMs;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}

// Materials API
export const materialsApi = {
  async list(): Promise<Material[]> {
    const response = await fetch(`${API_BASE}/materials`);
    const data = await handleResponse<{ materials: Material[] }>(response);
    return data.materials;
  },

  async upload(
    files: File[],
    options: { type?: string; title?: string; chapters?: number[] } = {}
  ): Promise<{ results: Array<{ materialId?: string; success: boolean; error?: string }> }> {
    const formData = new FormData();
    files.forEach((file) => formData.append('files', file));
    if (options.type) formData.append('type', options.type);
    if (options.title) formData.append('title', options.title);
    if (options.chapters) formData.append('chapters', JSON.stringify(options.chapters));

    const response = await fetch(`${API_BASE}/materials`, {
      method: 'POST',
      body: formData,
    });
    return handleResponse(response);
  },

  async get(materialId: string, includeChunks = false): Promise<Material> {
    const response = await fetch(`${API_BASE}/materials/${materialId}?includeChunks=${includeChunks}`);
    const data = await handleResponse<{ material: Material }>(response);
    return data.material;
  },

  async delete(materialId: string): Promise<void> {
    const response = await fetch(`${API_BASE}/materials/${materialId}`, {
      method: 'DELETE',
    });
    await handleResponse(response);
  },

  async search(
    query: string,
    options: { chapters?: number[]; topK?: number } = {}
  ): Promise<Array<{ id: string; content: string; similarity: number }>> {
    const response = await fetch(`${API_BASE}/materials/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, ...options }),
    });
    const data = await handleResponse<{ results: Array<{ id: string; content: string; similarity: number }> }>(response);
    return data.results;
  },

  /**
   * Get the structure (chapters/topics) for all materials in a section
   * Used for chapter-specific quiz generation
   */
  async getSectionStructure(sectionId: string): Promise<SectionStructure> {
    const response = await fetch(`${API_BASE}/materials/section/${sectionId}/structure`);
    const data = await handleResponse<{ structure: SectionStructure }>(response);
    return data.structure;
  },
};

// Quiz API
export const quizApi = {
  async get(quizId: string): Promise<Quiz & { questions: Question[] }> {
    const response = await fetch(`${API_BASE}/quiz/${quizId}`);
    const data = await handleResponse<{ quiz: Quiz & { questions: Question[] } }>(response);
    return data.quiz;
  },

  async submit(
    quizId: string,
    answers: Record<string, string>
  ): Promise<{
    score: { correct: number; total: number; percentage: number };
    results: Array<{
      questionId: string;
      isCorrect: boolean;
      userAnswer: string;
      correctAnswer: string;
      explanation: string;
    }>;
  }> {
    const response = await fetch(`${API_BASE}/quiz/${quizId}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers }),
    });
    return handleResponse(response);
  },

  async delete(quizId: string): Promise<void> {
    const response = await fetch(`${API_BASE}/quiz/${quizId}`, {
      method: 'DELETE',
    });
    await handleResponse(response);
  },
};

// Flashcards API
export const flashcardsApi = {
  async get(setId: string): Promise<FlashcardSet & { cards: Flashcard[] }> {
    const response = await fetch(`${API_BASE}/flashcards/${setId}`);
    const data = await handleResponse<{ flashcardSet: FlashcardSet & { cards: Flashcard[] } }>(response);
    return data.flashcardSet;
  },
};

// Practice API - Generate quizzes/flashcards from sections
export interface GeneratedQuiz {
  quizId: string;
  name: string;
  description?: string;
  folderId?: string;
  questionCount: number;
  questions: Question[];
}

export interface GeneratedFlashcardSet {
  flashcardSetId: string;
  name: string;
  description?: string;
  folderId?: string;
  count: number;
  flashcards: Flashcard[];
}

// Practice folder types
export interface PracticeFolder {
  id: string;
  name: string;
  description?: string;
  color: string;
  icon: string;
  subfolders: PracticeFolder[];
  createdAt: string;
}

export interface SavedQuiz {
  id: string;
  name: string;
  description?: string;
  total_questions: number;
  difficulty: string;
  best_score?: number;
  attempt_count: number;
  last_attempted_at?: string;
  folder_id?: string;
  created_at: string;
  question_type?: 'multiple_choice' | 'true_false';
}

export interface SavedFlashcardSet {
  id: string;
  name: string;
  description?: string;
  total_cards: number;
  mastery_count: number;
  last_studied_at?: string;
  folder_id?: string;
  created_at: string;
}

export interface QuizAttempt {
  id: string;
  quiz_set_id: string;
  quiz_name?: string;
  score: number;
  total_questions: number;
  percentage: number;
  time_taken?: number;
  completed_at: string;
  answers?: Record<string, { answer: string; isCorrect: boolean; correctAnswer: string }>;
}

export interface PracticeOverview {
  folders: PracticeFolder[];
  quizzes: SavedQuiz[];
  flashcardSets: SavedFlashcardSet[];
  recentAttempts: QuizAttempt[];
  stats: {
    totalQuizzes: number;
    totalFlashcardSets: number;
    totalQuestions: number;
    totalCards: number;
  };
}

// Topic Analysis Types
export interface TopicPerformance {
  topic: string;
  chapter: number | null;
  totalAttempts: number;
  correctCount: number;
  accuracy: number;
  lastPracticed: string;
  quizNames: string[];
  needsWork: boolean;
}

export interface TopicAnalysis {
  topics: TopicPerformance[];
  summary: {
    totalTopics: number;
    weakTopicsCount: number;
    strongTopicsCount: number;
    overallAccuracy: number | null;
  };
  focusAreas: TopicPerformance[];
}

export const practiceApi = {
  // =====================
  // OVERVIEW & FOLDERS
  // =====================
  
  async getOverview(userId: string): Promise<PracticeOverview> {
    // Use retry logic for this critical call - handles database cold starts and intermittent failures
    return withRetry(async () => {
      const response = await fetch(`${API_BASE}/practice/overview?userId=${userId}`);
      const data = await handleResponse<PracticeOverview & { success: boolean }>(response);
      return {
        folders: data.folders,
        quizzes: data.quizzes,
        flashcardSets: data.flashcardSets,
        recentAttempts: data.recentAttempts,
        stats: data.stats
      };
    }, { maxRetries: 3, delayMs: 500, backoff: true });
  },

  async getTopicAnalysis(userId: string): Promise<TopicAnalysis> {
    const response = await fetch(`${API_BASE}/practice/topic-analysis?userId=${userId}`);
    const data = await handleResponse<{ topicAnalysis: TopicAnalysis }>(response);
    return data.topicAnalysis;
  },

  async listFolders(userId: string): Promise<PracticeFolder[]> {
    // Use retry logic for this critical call
    return withRetry(async () => {
      const response = await fetch(`${API_BASE}/practice/folders?userId=${userId}`);
      const data = await handleResponse<{ folders: PracticeFolder[] }>(response);
      return data.folders;
    }, { maxRetries: 3, delayMs: 500, backoff: true });
  },

  async createFolder(options: {
    name: string;
    userId: string;
    description?: string;
    parentFolderId?: string;
    color?: string;
    icon?: string;
  }): Promise<PracticeFolder> {
    const response = await fetch(`${API_BASE}/practice/folders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options),
    });
    const data = await handleResponse<{ folder: PracticeFolder }>(response);
    return data.folder;
  },

  async updateFolder(folderId: string, options: {
    name?: string;
    description?: string;
    color?: string;
    icon?: string;
  }): Promise<PracticeFolder> {
    const response = await fetch(`${API_BASE}/practice/folders/${folderId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options),
    });
    const data = await handleResponse<{ folder: PracticeFolder }>(response);
    return data.folder;
  },

  async deleteFolder(folderId: string): Promise<void> {
    const response = await fetch(`${API_BASE}/practice/folders/${folderId}`, {
      method: 'DELETE',
    });
    await handleResponse(response);
  },

  // =====================
  // QUIZ OPERATIONS
  // =====================

  async generateQuiz(options: {
    sectionIds: string[];
    userId: string;
    questionCount?: number;
    questionType?: 'multiple_choice' | 'true_false' | 'short_answer';
    difficulty?: 'easy' | 'medium' | 'hard' | 'mixed';
    name?: string;
    folderId?: string;
    description?: string;
    onProgress?: (message: string) => void;
    chapterFilter?: Array<{ materialId: string; chapters: number[] }>;  // Filter by specific chapters
  }): Promise<GeneratedQuiz> {
    // Use direct backend URL to bypass Next.js proxy timeout
    // LLM-based generation can take 30-90+ seconds
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5 * 60 * 1000); // Increased to 5 minutes

    try {
      const isStreaming = !!options.onProgress;
      
      const response = await fetch(`${BACKEND_API}/practice/quizzes/generate?stream=${isStreaming}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...options, stream: isStreaming }),
        signal: controller.signal,
      });

      if (!isStreaming) {
        clearTimeout(timeoutId);
        const data = await handleResponse<{ quiz: GeneratedQuiz }>(response);
        return data.quiz;
      }

      // Handle streaming response
      if (!response.body) throw new Error('ReadableStream not supported');
      
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finalResult: GeneratedQuiz | null = null;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // Keep incomplete line
          
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const data = JSON.parse(line);
              if (data.type === 'progress' && options.onProgress) {
                options.onProgress(data.message);
              } else if (data.type === 'result') {
                finalResult = data.quiz;
              } else if (data.type === 'error') {
                 throw new Error(data.error);
              }
            } catch (e) {
               if (e instanceof Error && e.message !== 'Unexpected end of JSON input') {
                 console.warn('Error parsing stream chunk:', e);
               }
            }
          }
        }
      } finally {
        reader.releaseLock();
        clearTimeout(timeoutId);
      }

      if (!finalResult) {
        throw new Error('No quiz result received from stream');
      }
      return finalResult;
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('Quiz generation timed out. Try with fewer questions or smaller content selection.');
      }
      throw err;
    }
  },

  async getQuiz(quizId: string): Promise<Quiz & { questions: Question[] }> {
    const response = await fetch(`${API_BASE}/practice/quizzes/${quizId}`);
    const data = await handleResponse<{ quiz: Quiz & { questions: Question[] } }>(response);
    return data.quiz;
  },

  async updateQuiz(quizId: string, options: {
    name?: string;
    description?: string;
    folderId?: string | null;
  }): Promise<SavedQuiz> {
    const response = await fetch(`${API_BASE}/practice/quizzes/${quizId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options),
    });
    const data = await handleResponse<{ quiz: SavedQuiz }>(response);
    return data.quiz;
  },

  async deleteQuiz(quizId: string): Promise<void> {
    const response = await fetch(`${API_BASE}/practice/quizzes/${quizId}`, {
      method: 'DELETE',
    });
    await handleResponse(response);
  },

  async submitQuizAttempt(quizId: string, options: {
    userId: string;
    answers: Record<string, string>;
    timeTaken?: number;
  }): Promise<{
    score: { correct: number; total: number; percentage: number };
    results: Array<{
      questionId: string;
      answer: string;
      isCorrect: boolean;
      correctAnswer: string;
      explanation?: string;
    }>;
  }> {
    const response = await fetch(`${API_BASE}/practice/quizzes/${quizId}/attempt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options),
    });
    return handleResponse(response);
  },

  async getQuizAttempts(quizId: string): Promise<QuizAttempt[]> {
    const response = await fetch(`${API_BASE}/practice/quizzes/${quizId}/attempts`);
    const data = await handleResponse<{ attempts: QuizAttempt[] }>(response);
    return data.attempts;
  },

  // =====================
  // FLASHCARD OPERATIONS
  // =====================

  async generateFlashcards(options: {
    sectionIds: string[];
    userId: string;
    count?: number;
    topic?: string;
    name?: string;
    folderId?: string;
    description?: string;
    chapterFilter?: Array<{ materialId: string; chapters: number[] }>;  // Filter by specific chapters
  }): Promise<GeneratedFlashcardSet> {
    // Use direct backend URL to bypass Next.js proxy timeout
    // LLM-based generation can take 30-90+ seconds
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5 * 60 * 1000); // Increased to 5 minutes

    try {
      const response = await fetch(`${BACKEND_API}/practice/flashcards/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      const data = await handleResponse<{ flashcardSet: GeneratedFlashcardSet }>(response);
      return data.flashcardSet;
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('Flashcard generation timed out. Try with fewer cards or smaller content selection.');
      }
      throw err;
    }
  },

  /**
   * Derive flashcards from multiple choice quiz questions
   * Front = question text, Back = correct answer text
   */
  async deriveFlashcardsFromQuiz(options: {
    quizId?: string;
    questions?: Question[];
    userId: string;
    sectionIds?: string[];
    name?: string;
    folderId?: string;
    description?: string;
  }): Promise<GeneratedFlashcardSet> {
    const response = await fetch(`${BACKEND_API}/practice/flashcards/from-quiz`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options),
    });
    const data = await handleResponse<{ flashcardSet: GeneratedFlashcardSet }>(response);
    return data.flashcardSet;
  },

  async getFlashcardSet(setId: string): Promise<FlashcardSet & { cards: Flashcard[] }> {
    const response = await fetch(`${API_BASE}/practice/flashcards/${setId}`);
    const data = await handleResponse<{ flashcardSet: FlashcardSet & { cards: Flashcard[] } }>(response);
    return data.flashcardSet;
  },

  async updateFlashcardSet(setId: string, options: {
    name?: string;
    description?: string;
    folderId?: string | null;
  }): Promise<SavedFlashcardSet> {
    const response = await fetch(`${API_BASE}/practice/flashcards/${setId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options),
    });
    const data = await handleResponse<{ flashcardSet: SavedFlashcardSet }>(response);
    return data.flashcardSet;
  },

  async deleteFlashcardSet(setId: string): Promise<void> {
    const response = await fetch(`${API_BASE}/practice/flashcards/${setId}`, {
      method: 'DELETE',
    });
    await handleResponse(response);
  },

  async recordFlashcardSession(setId: string, options: {
    userId: string;
    cardsStudied: number;
    cardsMastered?: number;
    timeSpent?: number;
  }): Promise<void> {
    const response = await fetch(`${API_BASE}/practice/flashcards/${setId}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options),
    });
    await handleResponse(response);
  },

  // Legacy methods for backwards compatibility
  async getUserQuizzes(userId: string): Promise<Quiz[]> {
    const response = await fetch(`${API_BASE}/users/${userId}/quizzes`);
    const data = await handleResponse<{ quizzes: Quiz[] }>(response);
    return data.quizzes;
  },

  async getUserFlashcardSets(userId: string): Promise<FlashcardSet[]> {
    const response = await fetch(`${API_BASE}/users/${userId}/flashcard-sets`);
    const data = await handleResponse<{ flashcardSets: FlashcardSet[] }>(response);
    return data.flashcardSets;
  },
};

// Folder types
export interface FileWarning {
  type: string;
  message: string;
  suggestion: string;
  fileName?: string;
}

export interface FileItem {
  id: string;
  name: string;
  uploadDate: string;
  materialId?: string;
  textContent?: string;
  size?: string;
  processing?: boolean;
  warning?: FileWarning;
}

export interface MaterialSection {
  id: string;
  title: string;
  description: string;
  files: FileItem[];
  type: 'textbook' | 'syllabus' | 'lecture_notes' | 'practice_questions' | 'custom';
}

export interface Folder {
  id: string;
  name: string;
  subfolders: Folder[];
  sections: MaterialSection[];
}

// Folders API
export const foldersApi = {
  async list(userId: string): Promise<Folder[]> {
    // Use retry logic for this critical call - handles database cold starts and intermittent failures
    return withRetry(async () => {
      const response = await fetch(`${API_BASE}/folders?userId=${userId}`);
      const data = await handleResponse<{ folders: Folder[] }>(response);
      return data.folders;
    }, { maxRetries: 3, delayMs: 500, backoff: true });
  },

  async create(name: string, userId: string, parentFolderId?: string): Promise<Folder> {
    const response = await fetch(`${API_BASE}/folders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, userId, parentFolderId }),
    });
    const data = await handleResponse<{ folder: Folder }>(response);
    return data.folder;
  },

  async update(folderId: string, name: string): Promise<Folder> {
    const response = await fetch(`${API_BASE}/folders/${folderId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const data = await handleResponse<{ folder: Folder }>(response);
    return data.folder;
  },

  async delete(folderId: string): Promise<void> {
    const response = await fetch(`${API_BASE}/folders/${folderId}`, {
      method: 'DELETE',
    });
    await handleResponse(response);
  },

  async createFolderSection(folderId: string, title: string, description: string, type: string): Promise<MaterialSection> {
    const response = await fetch(`${API_BASE}/folders/${folderId}/sections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, description, type }),
    });
    const data = await handleResponse<{ section: MaterialSection }>(response);
    return data.section;
  },

  async deleteSection(sectionId: string): Promise<void> {
    const response = await fetch(`${API_BASE}/sections/${sectionId}`, {
      method: 'DELETE',
    });
    await handleResponse(response);
  },

  async uploadFiles(sectionId: string, files: File[]): Promise<{ files: FileItem[]; warnings?: FileWarning[] }> {
    const formData = new FormData();
    files.forEach((file) => formData.append('files', file));

    // Use longer timeout for file uploads (5 minutes) since embedding generation takes time
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5 * 60 * 1000);

    try {
      const response = await fetch(`${API_BASE}/sections/${sectionId}/files`, {
        method: 'POST',
        body: formData,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      const data = await handleResponse<{ files: FileItem[]; warnings?: FileWarning[] }>(response);
      return { files: data.files, warnings: data.warnings };
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('Upload timed out. Large files may take several minutes to process.');
      }
      throw err;
    }
  },

  async deleteFile(fileId: string): Promise<void> {
    // Guard against temporary file IDs (not valid UUIDs)
    if (fileId.startsWith('temp-')) {
      return; // Silently ignore deletion of temp files
    }
    const response = await fetch(`${API_BASE}/files/${fileId}`, {
      method: 'DELETE',
    });
    await handleResponse(response);
  },

  async uploadYouTubeUrl(sectionId: string, url: string): Promise<{ file: FileItem; videoInfo?: { title: string; author: string; duration: number }; warning?: FileWarning }> {
    // Use longer timeout for YouTube transcription (5 minutes) since download + transcription takes time
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5 * 60 * 1000);

    try {
      const response = await fetch(`${API_BASE}/sections/${sectionId}/youtube`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      const data = await handleResponse<{ file: FileItem; videoInfo?: { title: string; author: string; duration: number }; warning?: FileWarning }>(response);
      return { file: data.file, videoInfo: data.videoInfo, warning: data.warning };
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('YouTube transcription timed out. The video may be too long or the connection was interrupted.');
      }
      throw err;
    }
  },

  async getFileContent(fileId: string): Promise<{ textContent: string | null; chunkCount?: number; message?: string }> {
    // Guard against temporary file IDs (not valid UUIDs)
    if (fileId.startsWith('temp-')) {
      return { textContent: null, message: 'File is currently being processed...' };
    }
    const response = await fetch(`${API_BASE}/files/${fileId}/content`);
    const data = await handleResponse<{ success: boolean; textContent: string | null; chunkCount?: number; message?: string }>(response);
    return { textContent: data.textContent, chunkCount: data.chunkCount, message: data.message };
  },

  async getSection(sectionId: string): Promise<MaterialSection> {
    const response = await fetch(`${API_BASE}/sections/${sectionId}`);
    const data = await handleResponse<{ section: MaterialSection }>(response);
    return data.section;
  },

  async uploadTranscript(sectionId: string, transcript: string, title?: string): Promise<{ file: FileItem }> {
    const response = await fetch(`${API_BASE}/sections/${sectionId}/transcript`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript, title }),
    });
    const data = await handleResponse<{ file: FileItem }>(response);
    return { file: data.file };
  },

  async getContentStructure(sectionId: string): Promise<SectionStructure> {
    const response = await fetch(`${API_BASE}/materials/section/${sectionId}/structure`);
    const data = await handleResponse<{ success: boolean; structure: SectionStructure }>(response);
    return data.structure;
  },
};

// Content structure types (re-export for backward compatibility)
// The main types are defined at the top of the file: MaterialStructure, SectionStructure, etc.

// Health check
export const healthApi = {
  async check(): Promise<{ status: string; timestamp: string }> {
    const response = await fetch(`${API_BASE}/health`);
    return handleResponse(response);
  },
};

// User types and API
export interface User {
  id: string;
  google_id: string;
  email: string;
  name?: string;
  image?: string;
  created_at: string;
  updated_at: string;
}

export const usersApi = {
  async upsert(data: {
    googleId: string;
    email: string;
    name?: string;
    image?: string;
  }): Promise<{ user: User; created: boolean }> {
    const response = await fetch(`${API_BASE}/users/upsert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return handleResponse(response);
  },

  async getByGoogleId(googleId: string): Promise<User> {
    const response = await fetch(`${API_BASE}/users/by-google-id/${googleId}`);
    const data = await handleResponse<{ user: User }>(response);
    return data.user;
  },
};
