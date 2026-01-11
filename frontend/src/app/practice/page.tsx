"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useSession } from "next-auth/react";
import VoiceAgent, { type VoiceAction, type VoiceAgentRef } from "@/app/components/VoiceAgent";
import { useData } from "@/app/context/DataContext";
import {
  foldersApi,
  practiceApi,
  materialsApi,
  type Folder,
  type MaterialSection,
  type GeneratedQuiz,
  type GeneratedFlashcardSet,
  type Question,
  type Flashcard,
  type PracticeFolder,
  type SavedQuiz,
  type SavedFlashcardSet,
  type PracticeOverview,
  type SectionStructure,
  type MaterialStructure,
  type MaterialChapter,
  type TopicAnalysis,
} from "@/lib/api";

// View modes for the practice page
type ViewMode = 'overview' | 'generate' | 'quiz' | 'flashcards' | 'folder';

// Practice mode for viewing a set
type PracticeMode = 'multiple_choice' | 'true_false' | 'flashcards';

// Generation type - what the user wants to create
type GenerationType = 'multiple_choice' | 'true_false' | 'flashcards';

// Flattened item for selection
interface SelectableItem {
  id: string;
  type: 'folder' | 'material';
  name: string;
  description?: string;
  fileCount: number;
  path: string[];
  folderId?: string;
  sectionId?: string;
  parentFolderId?: string;
}

export default function PracticePage() {
  const { data: session } = useSession();
  const { 
    folders: materialFolders, 
    practiceOverview, 
    isLoadingFolders, 
    isLoadingOverview,
    refreshPracticeOverview 
  } = useData();
  const [viewMode, setViewMode] = useState<ViewMode>('overview');
  
  // Material folders for generation (managed by DataContext)
  // const [materialFolders, setMaterialFolders] = useState<Folder[]>([]);
  
  // Practice data (managed by DataContext)
  // const [practiceOverview, setPracticeOverview] = useState<PracticeOverview | null>(null);
  const [selectedPracticeFolder, setSelectedPracticeFolder] = useState<string | null>(null);
  
  // Loading & error states
  const [localLoading, setLocalLoading] = useState(false);
  const isLoading = isLoadingFolders || isLoadingOverview || localLoading;
  const [error, setError] = useState<string | null>(null);
  
  // Selection state for generation
  // selectedFolders: when a folder is selected, ALL its contents are included
  // selectedMaterials: individual materials selected (only when parent folder is NOT selected)
  const [selectedFolders, setSelectedFolders] = useState<Set<string>>(new Set());
  const [selectedMaterials, setSelectedMaterials] = useState<Set<string>>(new Set());
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  
  // Chapter selection state for granular quiz generation
  const [sectionStructures, setSectionStructures] = useState<Map<string, SectionStructure>>(new Map());
  const [loadingStructures, setLoadingStructures] = useState<Set<string>>(new Set());
  // Map: sectionId -> Set of selected file/material IDs (when empty and section selected = all files)
  const [selectedFiles, setSelectedFiles] = useState<Map<string, Set<string>>>(new Map());
  // Map: materialId -> Set of selected chapter numbers (empty set = all chapters)
  const [selectedChapters, setSelectedChapters] = useState<Map<string, Set<number>>>(new Map());
  const [expandedMaterials, setExpandedMaterials] = useState<Set<string>>(new Set());
  
  // Practice set generation state
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationStatus, setGenerationStatus] = useState<string>('');
  const [setSize, setSetSize] = useState<string>('20');
  const [practiceNameInput, setPracticeNameInput] = useState('');
  const [saveToPracticeFolder, setSaveToPracticeFolder] = useState<string | null>(null);
  const [selectedGenerationType, setSelectedGenerationType] = useState<GenerationType>('multiple_choice');

  // Generated content state
  const [generatedQuiz, setGeneratedQuiz] = useState<GeneratedQuiz | null>(null);
  const [generatedFlashcards, setGeneratedFlashcards] = useState<GeneratedFlashcardSet | null>(null);
  
  // Active quiz/flashcard for viewing saved ones
  const [activeQuizId, setActiveQuizId] = useState<string | null>(null);
  const [activeFlashcardSetId, setActiveFlashcardSetId] = useState<string | null>(null);
  const [activeQuiz, setActiveQuiz] = useState<(SavedQuiz & { questions: Question[] }) | null>(null);
  const [activeFlashcardSet, setActiveFlashcardSet] = useState<(SavedFlashcardSet & { cards: Flashcard[] }) | null>(null);

  // Practice mode state - for choosing how to practice a set
  const [practiceMode, setPracticeMode] = useState<PracticeMode>('multiple_choice');

  // Active folder for folder detail view
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);
  // Track where we came from to navigate back correctly
  const [previousView, setPreviousView] = useState<ViewMode>('overview');
  
  // Quiz taking state
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [selectedAnswers, setSelectedAnswers] = useState<Record<string, string>>({});
  const [showResults, setShowResults] = useState(false);
  const [quizStartTime, setQuizStartTime] = useState<number | null>(null);
  
  // Flashcard state
  const [currentCardIndex, setCurrentCardIndex] = useState(0);
  const [isFlipped, setIsFlipped] = useState(false);
  const [masteredCards, setMasteredCards] = useState<Set<string>>(new Set());
  const [needsPracticeCards, setNeedsPracticeCards] = useState<Set<string>>(new Set());
  const [flashcardSessionSaved, setFlashcardSessionSaved] = useState(false);

  // Voice Agent state
  const [isVoiceAgentOpen, setIsVoiceAgentOpen] = useState(false);
  const voiceAgentRef = useRef<VoiceAgentRef>(null);
  const shouldAutoReadQuestionRef = useRef(false);
  const shouldAutoReadCardRef = useRef(false);
  const shouldAutoAdvanceRef = useRef(false);
  const lastAnsweredQuestionRef = useRef<{ questionId: string; answer: string } | null>(null);

  // Keep refs in sync with state for voice handlers (to avoid stale closures)
  const currentQuestionIndexRef = useRef(currentQuestionIndex);
  const currentCardIndexRef = useRef(currentCardIndex);

  // Question overview modal state
  const [showQuestionOverview, setShowQuestionOverview] = useState(false);

  // Create folder modal
  const [showCreateFolderModal, setShowCreateFolderModal] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [newFolderDescription, setNewFolderDescription] = useState('');
  const [newFolderColor, setNewFolderColor] = useState('#6366f1');

  // Topic analysis state
  const [topicAnalysis, setTopicAnalysis] = useState<TopicAnalysis | null>(null);
  const [isLoadingTopicAnalysis, setIsLoadingTopicAnalysis] = useState(false);

  const userId = session?.user?.id;

  // Keep refs in sync with state
  useEffect(() => {
    currentQuestionIndexRef.current = currentQuestionIndex;
  }, [currentQuestionIndex]);

  useEffect(() => {
    currentCardIndexRef.current = currentCardIndex;
  }, [currentCardIndex]);

  // Helper to get hex color for folder (handles both hex and named colors)
  const getFolderColor = (color: string): string => {
    // If it's already a hex color, return it
    if (color?.startsWith('#')) return color;
    
    // Map named colors to hex
    const colorMap: Record<string, string> = {
      indigo: '#6366f1',
      blue: '#3b82f6',
      purple: '#a855f7',
      pink: '#ec4899',
      red: '#ef4444',
      orange: '#f97316',
      amber: '#f59e0b',
      green: '#22c55e',
      teal: '#14b8a6',
      cyan: '#06b6d4',
    };
    return colorMap[color] || '#6366f1';
  };

  // Load data effect removed - handled by DataProvider


  // Keyboard shortcut for voice agent (V key)
  useEffect(() => {
    const handleKeyPress = (e: KeyboardEvent) => {
      // Only trigger if not typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }
      
      // Press 'V' to open voice agent
      if (e.key === 'v' || e.key === 'V') {
        e.preventDefault();
        setIsVoiceAgentOpen(prev => !prev);
      }
    };

    window.addEventListener('keydown', handleKeyPress);
    return () => window.removeEventListener('keydown', handleKeyPress);
  }, []);

  // Load topic analysis when user ID is available
  useEffect(() => {
    const loadTopicAnalysis = async () => {
      if (!userId) return;
      
      setIsLoadingTopicAnalysis(true);
      try {
        const analysis = await practiceApi.getTopicAnalysis(userId);
        setTopicAnalysis(analysis);
      } catch (err) {
        console.error('Failed to load topic analysis:', err);
        // Don't show error to user - this is supplementary data
      } finally {
        setIsLoadingTopicAnalysis(false);
      }
    };

    loadTopicAnalysis();
  }, [userId]);

  // Refresh topic analysis after quiz submission
  const refreshTopicAnalysis = useCallback(async () => {
    if (!userId) return;
    try {
      const analysis = await practiceApi.getTopicAnalysis(userId);
      setTopicAnalysis(analysis);
    } catch (err) {
      console.error('Failed to refresh topic analysis:', err);
    }
  }, [userId]);

  // Auto-expand all folders when entering generate view
  useEffect(() => {
    if (viewMode === 'generate' && materialFolders.length > 0) {
      const allFolderIds = new Set<string>();
      const collectFolderIds = (folders: Folder[]) => {
        folders.forEach(folder => {
          allFolderIds.add(folder.id);
          collectFolderIds(folder.subfolders);
        });
      };
      collectFolderIds(materialFolders);
      setExpandedFolders(allFolderIds);
    }
  }, [viewMode, materialFolders]);

  // Load ALL section structures when entering generate view (so topics/chapters are available before selection)
  useEffect(() => {
    const loadAllStructures = async () => {
      // Collect ALL section IDs from all material folders
      const allSectionIds = new Set<string>();
      
      const collectAllSections = (folders: Folder[]) => {
        folders.forEach(folder => {
          folder.sections.forEach(s => allSectionIds.add(s.id));
          collectAllSections(folder.subfolders);
        });
      };
      collectAllSections(materialFolders);

      // Load structure for each section that we don't have yet
      for (const sectionId of allSectionIds) {
        if (!sectionStructures.has(sectionId) && !loadingStructures.has(sectionId)) {
          setLoadingStructures(prev => new Set(prev).add(sectionId));
          try {
            const structure = await materialsApi.getSectionStructure(sectionId);
            setSectionStructures(prev => new Map(prev).set(sectionId, structure));
          } catch (err) {
            console.error('Failed to load section structure:', err);
          } finally {
            setLoadingStructures(prev => {
              const next = new Set(prev);
              next.delete(sectionId);
              return next;
            });
          }
        }
      }
    };

    if (viewMode === 'generate' && materialFolders.length > 0) {
      loadAllStructures();
    }
  }, [viewMode, materialFolders, sectionStructures, loadingStructures]);

  // Auto-read first question/card when entering quiz/flashcard mode with voice agent open
  const prevViewModeRef = useRef<ViewMode>(viewMode);
  useEffect(() => {
    const prevViewMode = prevViewModeRef.current;
    prevViewModeRef.current = viewMode;

    // If we just entered quiz mode and voice agent is open, read the first question
    if (viewMode === 'quiz' && prevViewMode !== 'quiz' && isVoiceAgentOpen && !showResults) {
      const questions = generatedQuiz?.questions || activeQuiz?.questions || [];
      if (questions.length > 0 && voiceAgentRef.current) {
        // Small delay to let the UI settle
        setTimeout(async () => {
          const quizName = generatedQuiz?.name || activeQuiz?.name || 'your quiz';
          await voiceAgentRef.current?.speakText(`Starting ${quizName} with ${questions.length} questions. Let's begin.`);
          // Then read the first question
          setTimeout(() => {
            const currentQuestion = questions[0];
            if (currentQuestion && voiceAgentRef.current) {
              const questionText = `Question 1 of ${questions.length}. ${currentQuestion.question}`;
              const answersText = currentQuestion.options
                ? Object.entries(currentQuestion.options).map(([k, v]) => `${k}: ${v}`).join('. ')
                : '';
              voiceAgentRef.current.speakText(`${questionText} The options are: ${answersText}`);
            }
          }, 500);
        }, 500);
      }
    }

    // If we just entered flashcard mode and voice agent is open, read the first card
    if (viewMode === 'flashcards' && prevViewMode !== 'flashcards' && isVoiceAgentOpen) {
      const cards = generatedFlashcards?.flashcards || activeFlashcardSet?.cards || [];
      if (cards.length > 0 && voiceAgentRef.current) {
        setTimeout(async () => {
          const setName = generatedFlashcards?.name || activeFlashcardSet?.name || 'your flashcard set';
          await voiceAgentRef.current?.speakText(`Starting ${setName} with ${cards.length} cards. Let's begin.`);
          // Then read the first card
          setTimeout(() => {
            const currentCard = cards[0];
            if (currentCard && voiceAgentRef.current) {
              const frontText = currentCard.front || currentCard.question || '';
              voiceAgentRef.current.speakText(`Card 1 of ${cards.length}. ${frontText}`);
            }
          }, 500);
        }, 500);
      }
    }
  }, [viewMode, isVoiceAgentOpen, showResults, generatedQuiz, activeQuiz, generatedFlashcards, activeFlashcardSet]);

  // Auto-read question when currentQuestionIndex changes (for hands-free navigation)
  useEffect(() => {
    if (shouldAutoReadQuestionRef.current && isVoiceAgentOpen && viewMode === 'quiz' && !showResults) {
      shouldAutoReadQuestionRef.current = false;
      const questions = generatedQuiz?.questions || activeQuiz?.questions || [];
      const currentQuestion = questions[currentQuestionIndex];
      if (currentQuestion && voiceAgentRef.current) {
        // Stop any ongoing speech before reading new question
        voiceAgentRef.current.stopSpeaking();
        setTimeout(() => {
          const questionText = `Question ${currentQuestionIndex + 1} of ${questions.length}. ${currentQuestion.question}`;
          const answersText = currentQuestion.options
            ? Object.entries(currentQuestion.options).map(([k, v]) => `${k}: ${v}`).join('. ')
            : '';
          voiceAgentRef.current?.speakText(`${questionText} The options are: ${answersText}`);
        }, 300);
      }
    }
  }, [currentQuestionIndex, isVoiceAgentOpen, viewMode, showResults, generatedQuiz, activeQuiz]);

  // Auto-read card when currentCardIndex or isFlipped changes (for hands-free navigation)
  useEffect(() => {
    if (shouldAutoReadCardRef.current && isVoiceAgentOpen && viewMode === 'flashcards') {
      shouldAutoReadCardRef.current = false;
      const cards = generatedFlashcards?.flashcards || activeFlashcardSet?.cards || [];
      const currentCard = cards[currentCardIndex];
      if (currentCard && voiceAgentRef.current) {
        // Stop any ongoing speech before reading new card
        voiceAgentRef.current.stopSpeaking();
        setTimeout(() => {
          const cardNumber = currentCardIndex + 1;
          const totalCards = cards.length;

          if (!isFlipped) {
            const frontText = currentCard.front || currentCard.question || '';
            const text = `Card ${cardNumber} of ${totalCards}. ${frontText}`;
            voiceAgentRef.current?.speakText(text);
          } else {
            const backText = currentCard.back || currentCard.explanation || '';
            const topicText = currentCard.topic ? ` Topic: ${currentCard.topic}.` : '';
            const text = `Answer: ${backText}.${topicText}`;
            voiceAgentRef.current?.speakText(text);
          }
        }, 300);
      }
    }
  }, [currentCardIndex, isFlipped, isVoiceAgentOpen, viewMode, generatedFlashcards, activeFlashcardSet]);

  // Submit quiz handler - defined before useEffects that depend on it
  const handleSubmitQuiz = useCallback(async () => {
    const quizId = generatedQuiz?.quizId || activeQuizId;
    if (!quizId || !userId) {
      setShowResults(true);
      return;
    }

    try {
      const timeTaken = quizStartTime ? Math.round((Date.now() - quizStartTime) / 1000) : undefined;
      await practiceApi.submitQuizAttempt(quizId, {
        userId,
        answers: selectedAnswers,
        timeTaken,
      });
      setShowResults(true);
      refreshPracticeOverview(); // Refresh to get updated stats
      refreshTopicAnalysis(); // Refresh topic analysis with new performance data
    } catch (err) {
      console.error('Failed to submit quiz:', err);
      setShowResults(true); // Still show results even if save failed
    }
  }, [generatedQuiz?.quizId, activeQuizId, userId, quizStartTime, selectedAnswers, refreshPracticeOverview, refreshTopicAnalysis]);

  // Auto-advance to next question after answer is recorded (for hands-free mode)
  useEffect(() => {
    if (shouldAutoAdvanceRef.current && viewMode === 'quiz' && !showResults) {
      shouldAutoAdvanceRef.current = false;

      const questions = generatedQuiz?.questions || activeQuiz?.questions || [];

      // Build the updated answers including the one we just recorded
      const updatedAnswers = { ...selectedAnswers };
      if (lastAnsweredQuestionRef.current) {
        updatedAnswers[lastAnsweredQuestionRef.current.questionId] = lastAnsweredQuestionRef.current.answer;
        lastAnsweredQuestionRef.current = null; // Clear after using
      }

      // Find next unanswered question starting from currentQuestionIndex + 1
      let nextUnanswered = -1;
      for (let i = currentQuestionIndex + 1; i < questions.length; i++) {
        const q = questions[i];
        const questionId = q.id ? String(q.id) : `q-${i}`;
        const answer = updatedAnswers[questionId];
        if (!answer || answer === '') {
          nextUnanswered = i;
          break;
        }
      }

      // If no unanswered questions after current, wrap around from beginning
      if (nextUnanswered === -1) {
        for (let i = 0; i < currentQuestionIndex; i++) {
          const q = questions[i];
          const questionId = q.id ? String(q.id) : `q-${i}`;
          const answer = updatedAnswers[questionId];
          if (!answer || answer === '') {
            nextUnanswered = i;
            break;
          }
        }
      }

      if (nextUnanswered === -1) {
        // All questions answered - submit the quiz
        if (voiceAgentRef.current && isVoiceAgentOpen) {
          voiceAgentRef.current.speakText("All questions answered. Submitting your quiz.").then(() => {
            handleSubmitQuiz();
          });
        } else {
          handleSubmitQuiz();
        }
      } else {
        // Move to next unanswered question and flag for auto-read
        shouldAutoReadQuestionRef.current = true;
        setCurrentQuestionIndex(nextUnanswered);
      }
    }
  }, [selectedAnswers, viewMode, showResults, currentQuestionIndex, generatedQuiz, activeQuiz, isVoiceAgentOpen, handleSubmitQuiz]);

  // Load specific quiz or flashcard set
  const loadQuiz = async (quizId: string, mode: PracticeMode = 'multiple_choice') => {
    try {
      setLocalLoading(true);
      const quiz = await practiceApi.getQuiz(quizId);
      // Map the quiz to include required SavedQuiz properties
      const mappedQuiz: SavedQuiz & { questions: Question[] } = {
        id: quiz.id,
        name: quiz.name,
        total_questions: quiz.total_questions,
        difficulty: quiz.difficulty,
        created_at: quiz.created_at,
        attempt_count: 0,
        best_score: quiz.best_score,
        questions: quiz.questions || [],
      };
      setActiveQuiz(mappedQuiz);
      setActiveQuizId(quizId);
      setPracticeMode(mode);
      setCurrentQuestionIndex(0);
      setSelectedAnswers({});
      setShowResults(false);
      setQuizStartTime(Date.now());
      setPreviousView(viewMode);
      
      // Set view mode based on practice mode
      if (mode === 'flashcards') {
        // Convert quiz questions to flashcard format
        const flashcardSet: SavedFlashcardSet & { cards: Flashcard[] } = {
          id: quiz.id,
          name: quiz.name,
          total_cards: quiz.total_questions,
          created_at: quiz.created_at,
          mastery_count: 0,
          cards: (quiz.questions || []).map((q: Question) => ({
            id: q.id,
            front: q.question,
            back: q.explanation || (q.options && q.correct_answer ? `Answer: ${q.correct_answer} - ${q.options[q.correct_answer as keyof typeof q.options]}` : q.correct_answer) || 'No answer provided',
            topic: q.topic,
          })),
        };
        setActiveFlashcardSet(flashcardSet);
        setActiveFlashcardSetId(quizId);
        setCurrentCardIndex(0);
        setIsFlipped(false);
        setViewMode('flashcards');
      } else {
        setViewMode('quiz');
      }
    } catch (err) {
      console.error('Failed to load quiz:', err);
      setError('Failed to load practice set');
    } finally {
      setLocalLoading(false);
    }
  };

  // View quiz results/review (loads quiz and shows best attempt with answers)
  const viewQuizResults = async (quizId: string, mode: PracticeMode = 'multiple_choice') => {
    try {
      setLocalLoading(true);
      const quiz = await practiceApi.getQuiz(quizId);
      
      // Fetch attempts to get the best one
      let bestAttemptAnswers: Record<string, string> = {};
      try {
        const attempts = await practiceApi.getQuizAttempts(quizId);
        if (attempts.length > 0) {
          // Find the best attempt (highest percentage)
          const bestAttempt = attempts.reduce((best, current) => 
            current.percentage > best.percentage ? current : best
          , attempts[0]);
          
          // Extract answers from best attempt
          if (bestAttempt.answers) {
            // answers is an object like { "q-0": { answer: "A", isCorrect: true, ... }, ... }
            Object.entries(bestAttempt.answers).forEach(([questionId, data]) => {
              if (typeof data === 'object' && data !== null && 'answer' in data) {
                bestAttemptAnswers[questionId] = (data as { answer: string }).answer;
              }
            });
          }
        }
      } catch (attemptErr) {
        console.error('Failed to load quiz attempts:', attemptErr);
        // Continue without attempt data
      }
      
      const mappedQuiz: SavedQuiz & { questions: Question[] } = {
        id: quiz.id,
        name: quiz.name,
        total_questions: quiz.total_questions,
        difficulty: quiz.difficulty,
        created_at: quiz.created_at,
        attempt_count: 0,
        best_score: quiz.best_score,
        questions: quiz.questions || [],
      };
      setActiveQuiz(mappedQuiz);
      setActiveQuizId(quizId);
      setPracticeMode(mode);
      setCurrentQuestionIndex(0);
      setSelectedAnswers(bestAttemptAnswers); // Pre-populate with best attempt answers
      setShowResults(true); // Go straight to results view
      setPreviousView(viewMode);
      setViewMode('quiz');
    } catch (err) {
      console.error('Failed to load quiz:', err);
      setError('Failed to load practice set');
    } finally {
      setLocalLoading(false);
    }
  };

  const loadFlashcardSet = async (setId: string) => {
    try {
      setLocalLoading(true);
      const set = await practiceApi.getFlashcardSet(setId);
      // Map the set to include required SavedFlashcardSet properties
      const mappedSet: SavedFlashcardSet & { cards: Flashcard[] } = {
        id: set.id,
        name: set.name,
        total_cards: set.total_cards,
        created_at: set.created_at,
        mastery_count: set.mastery_count || 0,
        cards: set.cards || [],
      };
      setActiveFlashcardSet(mappedSet);
      setActiveFlashcardSetId(setId);
      setCurrentCardIndex(0);
      setIsFlipped(false);
      setMasteredCards(new Set());
      setNeedsPracticeCards(new Set());
      setFlashcardSessionSaved(false);
      setPreviousView(viewMode); // Track where we came from
      setViewMode('flashcards');
    } catch (err) {
      console.error('Failed to load flashcard set:', err);
      setError('Failed to load flashcards');
    } finally {
      setLocalLoading(false);
    }
  };

  // Build mapping of folder IDs to their children (sections and subfolders)
  const folderChildrenMap = useMemo(() => {
    const map = new Map<string, { sectionIds: string[], subfolderIds: string[] }>();
    
    const processFolder = (folder: Folder) => {
      const sectionIds = folder.sections.map(s => s.id);
      const subfolderIds = folder.subfolders.map(sf => sf.id);
      
      // Also collect all nested section IDs
      const collectAllSectionIds = (f: Folder): string[] => {
        let ids = f.sections.map(s => s.id);
        f.subfolders.forEach(sf => {
          ids = [...ids, ...collectAllSectionIds(sf)];
        });
        return ids;
      };
      
      map.set(folder.id, { 
        sectionIds: collectAllSectionIds(folder), 
        subfolderIds 
      });
      
      folder.subfolders.forEach(sf => processFolder(sf));
    };
    
    materialFolders.forEach(folder => processFolder(folder));
    return map;
  }, [materialFolders]);

  // Flatten folders and materials into selectable items
  const flattenedItems = useMemo(() => {
    const items: SelectableItem[] = [];

    const processFolder = (folder: Folder, path: string[] = [], parentFolderId?: string) => {
      const currentPath = [...path, folder.name];
      
      const countFiles = (f: Folder): number => {
        let count = f.sections.reduce((acc, s) => acc + s.files.length, 0);
        count += f.subfolders.reduce((acc, sf) => acc + countFiles(sf), 0);
        return count;
      };

      items.push({
        id: `folder-${folder.id}`,
        type: 'folder',
        name: folder.name,
        fileCount: countFiles(folder),
        path: path,
        folderId: folder.id,
        parentFolderId,
      });

      folder.sections.forEach(section => {
        items.push({
          id: `material-${section.id}`,
          type: 'material',
          name: section.title,
          description: section.description,
          fileCount: section.files.length,
          path: currentPath,
          sectionId: section.id,
          parentFolderId: folder.id,
        });
      });

      folder.subfolders.forEach(subfolder => {
        processFolder(subfolder, currentPath, folder.id);
      });
    };

    materialFolders.forEach(folder => processFolder(folder));
    return items;
  }, [materialFolders]);

  const materialItems = useMemo(() => 
    flattenedItems.filter(item => item.type === 'material'),
    [flattenedItems]
  );

  // Check if any ancestor folder is selected
  const isAncestorFolderSelected = (parentFolderId: string | undefined): boolean => {
    if (!parentFolderId) return false;
    
    let currentParentId: string | undefined = parentFolderId;
    while (currentParentId) {
      if (selectedFolders.has(currentParentId)) return true;
      const parentItem = flattenedItems.find(i => i.folderId === currentParentId);
      currentParentId = parentItem?.parentFolderId;
    }
    return false;
  };

  // Check if a folder is selected (directly or via ancestor)
  const isFolderSelected = (folderId: string): boolean => {
    if (selectedFolders.has(folderId)) return true;
    
    // Check if any ancestor is selected
    const folderItem = flattenedItems.find(i => i.folderId === folderId);
    if (folderItem?.parentFolderId) {
      return isAncestorFolderSelected(folderItem.parentFolderId);
    }
    return false;
  };

  // Check if a material is selected (via folder or individually)
  const isMaterialSelected = (sectionId: string, parentFolderId: string): boolean => {
    // Check if parent folder (or any ancestor) is selected
    if (selectedFolders.has(parentFolderId) || isAncestorFolderSelected(parentFolderId)) {
      return true;
    }
    // Check if individually selected
    return selectedMaterials.has(sectionId);
  };

  // Check if material selection is disabled (parent folder is selected)
  const isMaterialSelectionDisabled = (parentFolderId: string): boolean => {
    return selectedFolders.has(parentFolderId) || isAncestorFolderSelected(parentFolderId);
  };

  const selectedFileCount = useMemo(() => {
    let count = 0;
    const countedSections = new Set<string>();
    
    // Helper to find folder by ID (inline to avoid dependency issues)
    const findFolder = (folderList: Folder[], folderId: string): Folder | null => {
      for (const folder of folderList) {
        if (folder.id === folderId) return folder;
        const found = findFolder(folder.subfolders, folderId);
        if (found) return found;
      }
      return null;
    };
    
    // Count from selected folders
    selectedFolders.forEach(folderId => {
      const folderItem = flattenedItems.find(i => i.folderId === folderId);
      if (folderItem) {
        count += folderItem.fileCount;
        // Mark all sections in this folder as counted
        const folder = findFolder(materialFolders, folderId);
        if (folder) {
          const markSections = (f: Folder) => {
            f.sections.forEach(s => countedSections.add(s.id));
            f.subfolders.forEach(sf => markSections(sf));
          };
          markSections(folder);
        }
      }
    });
    
    // Count from individually selected materials (that aren't already in a selected folder)
    selectedMaterials.forEach(sectionId => {
      if (countedSections.has(sectionId)) return;
      const materialItem = flattenedItems.find(i => i.sectionId === sectionId);
      // If material is found and its parent folder is not selected, count its files
      if (materialItem) {
        if (!materialItem.parentFolderId || !isMaterialSelectionDisabled(materialItem.parentFolderId)) {
          count += materialItem.fileCount;
          countedSections.add(sectionId);
        }
      } else {
        // Material not found in flattenedItems but is selected - count as 1 file minimum
        count += 1;
        countedSections.add(sectionId);
      }
    });
    
    // Count from chapter-selected files (sections not already counted)
    selectedFiles.forEach((files, sectionId) => {
      if (countedSections.has(sectionId)) return;
      const materialItem = flattenedItems.find(i => i.sectionId === sectionId);
      if (!materialItem?.parentFolderId || !isMaterialSelectionDisabled(materialItem.parentFolderId)) {
        count += files.size;
      }
    });
    
    return count;
  }, [selectedFolders, selectedMaterials, selectedFiles, flattenedItems, materialFolders]);

  // Count total selected items (folders + individual materials + sections with chapter selections)
  const totalSelectedCount = useMemo(() => {
    let count = selectedFolders.size;
    const countedSections = new Set<string>();
    
    // Count materials that aren't already in a selected folder
    selectedMaterials.forEach(sectionId => {
      const materialItem = flattenedItems.find(i => i.sectionId === sectionId);
      // If material is found, check if parent folder is already selected
      if (materialItem) {
        if (!materialItem.parentFolderId || !isMaterialSelectionDisabled(materialItem.parentFolderId)) {
          count++;
          countedSections.add(sectionId);
        }
      } else {
        // Material not found in flattenedItems but is selected - still count it
        count++;
        countedSections.add(sectionId);
      }
    });
    
    // Also count sections with file/chapter selections that aren't already counted
    selectedFiles.forEach((files, sectionId) => {
      if (files.size > 0 && !countedSections.has(sectionId)) {
        const materialItem = flattenedItems.find(i => i.sectionId === sectionId);
        if (!materialItem?.parentFolderId || !isMaterialSelectionDisabled(materialItem.parentFolderId)) {
          count++;
        }
      }
    });
    
    return count;
  }, [selectedFolders, selectedMaterials, selectedFiles, flattenedItems]);

  // Toggle folder selection
  const toggleFolderSelection = (folderId: string) => {
    setSelectedFolders(prev => {
      const next = new Set(prev);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        // Remove any child folders that are selected (parent takes precedence)
        const removeChildSelections = (parentId: string) => {
          const children = folderChildrenMap.get(parentId);
          if (children) {
            children.subfolderIds.forEach(childId => {
              next.delete(childId);
              removeChildSelections(childId);
            });
            // Also remove any individually selected materials from this folder
            children.sectionIds.forEach(sectionId => {
              setSelectedMaterials(prevMats => {
                const nextMats = new Set(prevMats);
                nextMats.delete(sectionId);
                return nextMats;
              });
            });
          }
        };
        removeChildSelections(folderId);
        next.add(folderId);
      }
      return next;
    });
  };

  // Toggle individual material selection
  const toggleMaterialSelection = (sectionId: string) => {
    setSelectedMaterials(prev => {
      const next = new Set(prev);
      if (next.has(sectionId)) {
        next.delete(sectionId);
        // Clear file and chapter selections for this section
        setSelectedFiles(prevFiles => {
          const nextFiles = new Map(prevFiles);
          nextFiles.delete(sectionId);
          return nextFiles;
        });
        // Clear chapter selections for materials in this section
        const structure = sectionStructures.get(sectionId);
        if (structure?.materials) {
          setSelectedChapters(prevChapters => {
            const nextChapters = new Map(prevChapters);
            structure.materials.forEach(m => nextChapters.delete(m.id));
            return nextChapters;
          });
        }
      } else {
        next.add(sectionId);
        // Auto-select all files when selecting a material
        const structure = sectionStructures.get(sectionId);
        if (structure?.materials && structure.materials.length > 0) {
          setSelectedFiles(prevFiles => {
            const nextFiles = new Map(prevFiles);
            nextFiles.set(sectionId, new Set(structure.materials.map(m => m.id)));
            return nextFiles;
          });
          // Auto-select all chapters for each file
          setSelectedChapters(prevChapters => {
            const nextChapters = new Map(prevChapters);
            structure.materials.forEach(m => {
              if (m.hasChapters && m.chapters.length > 0) {
                nextChapters.set(m.id, new Set(m.chapters.map(ch => ch.number)));
              }
            });
            return nextChapters;
          });
        }
      }
      return next;
    });
  };

  // Toggle file selection within a section
  const toggleFileSelection = (sectionId: string, materialId: string, chapters: { number: number }[]) => {
    setSelectedFiles(prev => {
      const next = new Map(prev);
      const currentFiles = next.get(sectionId) || new Set<string>();
      const newFiles = new Set(currentFiles);
      
      if (newFiles.has(materialId)) {
        newFiles.delete(materialId);
        // Clear chapter selections for this file
        setSelectedChapters(prevChapters => {
          const nextChapters = new Map(prevChapters);
          nextChapters.delete(materialId);
          return nextChapters;
        });
      } else {
        newFiles.add(materialId);
        // Auto-select all chapters when selecting a file
        if (chapters.length > 0) {
          setSelectedChapters(prevChapters => {
            const nextChapters = new Map(prevChapters);
            nextChapters.set(materialId, new Set(chapters.map(ch => ch.number)));
            return nextChapters;
          });
        }
      }
      
      next.set(sectionId, newFiles);
      
      // If no files selected, also deselect the material
      if (newFiles.size === 0) {
        setSelectedMaterials(prevMats => {
          const nextMats = new Set(prevMats);
          nextMats.delete(sectionId);
          return nextMats;
        });
        next.delete(sectionId);
      } else if (!selectedMaterials.has(sectionId)) {
        // If selecting a file but material not selected, select it
        setSelectedMaterials(prevMats => {
          const nextMats = new Set(prevMats);
          nextMats.add(sectionId);
          return nextMats;
        });
      }
      
      return next;
    });
  };

  const toggleExpand = (folderId: string) => {
    setExpandedFolders(prev => {
      const next = new Set(prev);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      return next;
    });
  };

  const selectAll = () => {
    // Select all top-level folders (this includes everything)
    setSelectedFolders(new Set(materialFolders.map(f => f.id)));
    // Clear individual material selections (they're now covered by folders)
    setSelectedMaterials(new Set());
  };

  const clearSelection = () => {
    setSelectedFolders(new Set());
    setSelectedMaterials(new Set());
    setSelectedFiles(new Map());
    setSelectedChapters(new Map());
    setExpandedMaterials(new Set());
  };

  // Toggle chapter selection for a material
  // Note: Selecting chapters does NOT select the entire material/section - 
  // it only selects that specific chapter within the file
  const toggleChapterSelection = (sectionId: string, materialId: string, chapterNum: number, totalChapters: number) => {
    setSelectedChapters(prev => {
      const next = new Map(prev);
      const currentChapters = next.get(materialId) || new Set<number>();
      const newChapters = new Set(currentChapters);
      
      if (newChapters.has(chapterNum)) {
        newChapters.delete(chapterNum);
      } else {
        newChapters.add(chapterNum);
      }
      
      if (newChapters.size === 0) {
        next.delete(materialId);
        // If no chapters selected, deselect the file too
        setSelectedFiles(prevFiles => {
          const nextFiles = new Map(prevFiles);
          const currentFilesSet = nextFiles.get(sectionId);
          if (currentFilesSet) {
            const newFilesSet = new Set(currentFilesSet);
            newFilesSet.delete(materialId);
            if (newFilesSet.size === 0) {
              nextFiles.delete(sectionId);
            } else {
              nextFiles.set(sectionId, newFilesSet);
            }
          }
          return nextFiles;
        });
      } else {
        next.set(materialId, newChapters);
        // Ensure file is tracked when selecting chapters (but NOT the entire material/section)
        setSelectedFiles(prevFiles => {
          const nextFiles = new Map(prevFiles);
          const currentFilesSet = nextFiles.get(sectionId) || new Set<string>();
          if (!currentFilesSet.has(materialId)) {
            const newFilesSet = new Set(currentFilesSet);
            newFilesSet.add(materialId);
            nextFiles.set(sectionId, newFilesSet);
          }
          return nextFiles;
        });
        // Note: We intentionally do NOT add to selectedMaterials here
        // The generation logic will pick up sectionIds from selectedFiles
      }
      
      return next;
    });
  };

  // Select all chapters for a material
  const selectAllChapters = (materialId: string, chapters: MaterialChapter[]) => {
    setSelectedChapters(prev => {
      const next = new Map(prev);
      next.set(materialId, new Set(chapters.map(ch => ch.number)));
      return next;
    });
  };

  // Clear chapter selection for a material - also deselects the file
  const clearChapterSelection = (materialId: string) => {
    setSelectedChapters(prev => {
      const next = new Map(prev);
      next.delete(materialId);
      return next;
    });
    
    // Find and deselect the file from its parent section
    selectedFiles.forEach((files, sectionId) => {
      if (files.has(materialId)) {
        setSelectedFiles(prevFiles => {
          const nextFiles = new Map(prevFiles);
          const currentFilesSet = nextFiles.get(sectionId);
          if (currentFilesSet) {
            const newFilesSet = new Set(currentFilesSet);
            newFilesSet.delete(materialId);
            if (newFilesSet.size === 0) {
              nextFiles.delete(sectionId);
            } else {
              nextFiles.set(sectionId, newFilesSet);
            }
          }
          return nextFiles;
        });
      }
    });
  };

  // Toggle material expansion for chapter view
  const toggleMaterialExpansion = (materialId: string) => {
    setExpandedMaterials(prev => {
      const next = new Set(prev);
      if (next.has(materialId)) {
        next.delete(materialId);
      } else {
        next.add(materialId);
      }
      return next;
    });
  };

  // Check if material has chapters selected (for filtering)
  const hasChapterFilter = selectedChapters.size > 0;

  // Helper to find folder by ID
  const findFolderById = useCallback((folderList: Folder[], folderId: string): Folder | null => {
    for (const folder of folderList) {
      if (folder.id === folderId) return folder;
      const found = findFolderById(folder.subfolders, folderId);
      if (found) return found;
    }
    return null;
  }, []);

  // Get all materials with chapters from selected sections
  const materialsWithChapters = useMemo(() => {
    const result: MaterialStructure[] = [];
    
    // Collect all section IDs
    const sectionIds = new Set<string>();
    selectedMaterials.forEach(id => sectionIds.add(id));
    selectedFolders.forEach(folderId => {
      const folder = findFolderById(materialFolders, folderId);
      if (folder) {
        const collectSections = (f: Folder) => {
          f.sections.forEach(s => sectionIds.add(s.id));
          f.subfolders.forEach(sf => collectSections(sf));
        };
        collectSections(folder);
      }
    });

    // Get materials with chapters from structures
    sectionIds.forEach(sectionId => {
      const structure = sectionStructures.get(sectionId);
      if (structure) {
        structure.materials.forEach(mat => {
          if (mat.hasChapters && mat.chapters.length > 0) {
            result.push(mat);
          }
        });
      }
    });

    return result;
  }, [selectedMaterials, selectedFolders, materialFolders, sectionStructures, findFolderById]);

  // Helper to collect all section IDs from a folder
  const collectSectionIds = (folder: Folder, sectionIds: string[]) => {
    folder.sections.forEach(s => sectionIds.push(s.id));
    folder.subfolders.forEach(sf => collectSectionIds(sf, sectionIds));
  };

  // Handle practice set generation
  const handleGenerate = async () => {
    if (totalSelectedCount === 0) {
      setError('Please select at least one folder or material');
      return;
    }

    if (!userId) {
      setError('Please sign in to generate practice content');
      return;
    }

    const parsedSetSize = parseInt(setSize) || 20;
    if (parsedSetSize < 5 || parsedSetSize > 100) {
      setError('Set size must be between 5 and 100');
      return;
    }

    setIsGenerating(true);
    setError(null);

    try {
      const sectionIds: string[] = [];
      
      // Collect from selected folders
      selectedFolders.forEach(folderId => {
        const folder = findFolderById(materialFolders, folderId);
        if (folder) {
          collectSectionIds(folder, sectionIds);
        }
      });
      
      console.log('[Generate] Selected folders:', Array.from(selectedFolders));
      console.log('[Generate] Selected materials:', Array.from(selectedMaterials));
      console.log('[Generate] Selected files (from chapters):', Array.from(selectedFiles.keys()));
      console.log('[Generate] Section IDs from folders:', [...sectionIds]);
      
      // Collect from individually selected materials (that aren't already in a selected folder)
      selectedMaterials.forEach(sectionId => {
        const materialItem = flattenedItems.find(i => i.sectionId === sectionId);
        console.log('[Generate] Checking material:', sectionId, 'found item:', materialItem ? 'yes' : 'no', 'parentFolderId:', materialItem?.parentFolderId);
        
        // If parent folder is selected, material is already included via folder
        if (materialItem?.parentFolderId && isMaterialSelectionDisabled(materialItem.parentFolderId)) {
          console.log('[Generate] Skipping material (parent folder selected):', sectionId);
          return;
        }
        
        // Add if not already included
        if (!sectionIds.includes(sectionId)) {
          sectionIds.push(sectionId);
          console.log('[Generate] Added material section ID:', sectionId);
        }
      });

      // Also collect from selectedFiles (chapters selected without selecting entire material)
      selectedFiles.forEach((fileIds, sectionId) => {
        if (fileIds.size > 0 && !sectionIds.includes(sectionId)) {
          // Only add if parent folder is not already selected
          const materialItem = flattenedItems.find(i => i.sectionId === sectionId);
          if (!materialItem?.parentFolderId || !isMaterialSelectionDisabled(materialItem.parentFolderId)) {
            sectionIds.push(sectionId);
            console.log('[Generate] Added section ID from chapter selection:', sectionId);
          }
        }
      });

      console.log('[Generate] Final section IDs to send:', sectionIds);

      if (sectionIds.length === 0) {
        setError('No materials found in the selected items. Make sure selected folders contain files with processed content.');
        return;
      }

      // Generate the selected type only
      const baseName = practiceNameInput || `Practice Set - ${new Date().toISOString().split('T')[0]}`;
      
      // Build chapter filter if any chapters are selected
      const chapterFilter = selectedChapters.size > 0 
        ? Array.from(selectedChapters.entries()).map(([materialId, chapters]) => ({
            materialId,
            chapters: Array.from(chapters)
          }))
        : undefined;

      if (chapterFilter) {
        console.log('[Generate] Using chapter filter:', chapterFilter);
      }
      
      // Generate based on selected type
      if (selectedGenerationType === 'multiple_choice') {
        setGenerationStatus('Generating Multiple Choice questions...');
        const mcQuiz = await practiceApi.generateQuiz({
          sectionIds,
          userId,
          questionCount: parsedSetSize,
          questionType: 'multiple_choice',
          difficulty: 'mixed',
          name: baseName,
          folderId: saveToPracticeFolder || undefined,
          onProgress: (msg) => setGenerationStatus(msg),
          chapterFilter,
        });
        
        setGenerationStatus('');
        setGeneratedQuiz(mcQuiz);
        setGeneratedFlashcards(null);
        setCurrentQuestionIndex(0);
        setSelectedAnswers({});
        setShowResults(false);
        setQuizStartTime(Date.now());
        setPracticeMode('multiple_choice');
        setViewMode('quiz');
        
      } else if (selectedGenerationType === 'true_false') {
        setGenerationStatus('Generating True/False questions...');
        const tfQuiz = await practiceApi.generateQuiz({
          sectionIds,
          userId,
          questionCount: parsedSetSize,
          questionType: 'true_false',
          difficulty: 'mixed',
          name: baseName,
          folderId: saveToPracticeFolder || undefined,
          onProgress: (msg) => setGenerationStatus(msg),
          chapterFilter,
        });
        
        setGenerationStatus('');
        setGeneratedQuiz(tfQuiz);
        setGeneratedFlashcards(null);
        setCurrentQuestionIndex(0);
        setSelectedAnswers({});
        setShowResults(false);
        setQuizStartTime(Date.now());
        setPracticeMode('true_false');
        setViewMode('quiz');
        
      } else if (selectedGenerationType === 'flashcards') {
        // Generate flashcards directly
        setGenerationStatus('Generating flashcards...');
        const flashcardSet = await practiceApi.generateFlashcards({
          sectionIds,
          userId,
          count: parsedSetSize,
          name: baseName,
          folderId: saveToPracticeFolder || undefined,
          chapterFilter,
        });
        
        setGenerationStatus('');
        setGeneratedFlashcards(flashcardSet);
        setGeneratedQuiz(null);
        setCurrentCardIndex(0);
        setIsFlipped(false);
        setViewMode('flashcards');
      }
      
      // Refresh overview to show all new practice sets
      refreshPracticeOverview();
      
    } catch (err) {
      console.error('Failed to generate:', err);
      setError(err instanceof Error ? err.message : 'Failed to generate practice set');
    } finally {
      setIsGenerating(false);
    }
  };

  // Create practice folder
  const handleCreateFolder = async () => {
    if (!newFolderName.trim() || !userId) return;

    try {
      await practiceApi.createFolder({
        name: newFolderName.trim(),
        userId,
        description: newFolderDescription.trim() || undefined,
        color: newFolderColor,
      });
      setNewFolderName('');
      setNewFolderDescription('');
      setNewFolderColor('#6366f1');
      setShowCreateFolderModal(false);
      refreshPracticeOverview();
    } catch (err) {
      console.error('Failed to create folder:', err);
      setError('Failed to create folder');
    }
  };

  // Delete quiz or flashcard set
  const handleDeleteQuiz = async (quizId: string) => {
    if (!confirm('Are you sure you want to delete this practice set?')) return;
    try {
      await practiceApi.deleteQuiz(quizId);
      refreshPracticeOverview();
    } catch (err) {
      console.error('Failed to delete practice set:', err);
      setError('Failed to delete practice set');
    }
  };

  const handleDeleteFlashcardSet = async (setId: string) => {
    if (!confirm('Are you sure you want to delete this practice set?')) return;
    try {
      await practiceApi.deleteFlashcardSet(setId);
      refreshPracticeOverview();
    } catch (err) {
      console.error('Failed to delete practice set:', err);
      setError('Failed to delete practice set');
    }
  };

  const handleDeletePracticeFolder = async (folderId: string) => {
    if (!confirm('Are you sure you want to delete this folder and all its contents?')) return;
    try {
      await practiceApi.deleteFolder(folderId);
      refreshPracticeOverview();
    } catch (err) {
      console.error('Failed to delete folder:', err);
      setError('Failed to delete folder');
    }
  };

  // Enter a practice folder
  const handleEnterFolder = (folderId: string) => {
    setActiveFolderId(folderId);
    setViewMode('folder');
  };

  // Navigate from folder to generate with folder pre-selected
  const handleGenerateFromFolder = (folderId: string) => {
    setSaveToPracticeFolder(folderId);
    setPreviousView('folder'); // Remember we came from folder view
    setViewMode('generate');
  };

  // Get active folder details
  const getActiveFolder = () => {
    if (!activeFolderId || !practiceOverview) return null;
    return practiceOverview.folders.find(f => f.id === activeFolderId) || null;
  };

  // Get quizzes and flashcards for the active folder
  const getFolderQuizzes = () => {
    if (!activeFolderId || !practiceOverview) return [];
    return practiceOverview.quizzes.filter(q => q.folder_id === activeFolderId);
  };

  const getFolderFlashcardSets = () => {
    if (!activeFolderId || !practiceOverview) return [];
    return practiceOverview.flashcardSets.filter(f => f.folder_id === activeFolderId);
  };

  // Quiz navigation
  const handleSelectAnswer = useCallback((questionId: string, answer: string) => {
    // Ensure questionId is a string for consistent comparison
    const normalizedId = String(questionId);
    setSelectedAnswers(prev => ({ ...prev, [normalizedId]: answer }));
  }, []);

  const handleNextQuestion = () => {
    const questions = generatedQuiz?.questions || activeQuiz?.questions || [];
    if (currentQuestionIndex < questions.length - 1) {
      setCurrentQuestionIndex(prev => prev + 1);
    }
  };

  const handlePrevQuestion = () => {
    if (currentQuestionIndex > 0) {
      setCurrentQuestionIndex(prev => prev - 1);
    }
  };

  const handleResetQuiz = () => {
    setGeneratedQuiz(null);
    setActiveQuiz(null);
    setActiveQuizId(null);
    setSelectedAnswers({});
    setShowResults(false);
    setCurrentQuestionIndex(0);
    // Go back to folder view if we came from there
    setViewMode(previousView === 'folder' ? 'folder' : 'overview');
  };

  // Keyboard shortcuts for quiz options (1-4)
  useEffect(() => {
    const handleKeyPress = (e: KeyboardEvent) => {
      // Only trigger if not typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }
      
      // Only applicable in quiz mode and when results are not shown
      if (viewMode === 'quiz' && !showResults && (generatedQuiz || activeQuiz)) {
        const questions = generatedQuiz?.questions || activeQuiz?.questions || [];
        const currentQuestion = questions[currentQuestionIndex];
        
        if (!currentQuestion) return;
        
        // Map 1-4 keys to options
        const keyMap: Record<string, string> = {
          '1': 'A',
          '2': 'B',
          '3': 'C',
          '4': 'D'
        };
        
        const optionKey = keyMap[e.key];
        if (optionKey) {
          // Check if option exists for this question
          let isValidOption = false;
          
          if (practiceMode === 'true_false') {
             // In True/False mode, only A (True) and B (False) are valid
             isValidOption = optionKey === 'A' || optionKey === 'B';
          } else {
             // In Multiple Choice, check if option exists in question options
             isValidOption = currentQuestion.options && optionKey in currentQuestion.options;
          }
          
          if (isValidOption) {
             const questionId = currentQuestion.id ? String(currentQuestion.id) : `q-${currentQuestionIndex}`;
             handleSelectAnswer(questionId, optionKey);
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyPress);
    return () => window.removeEventListener('keydown', handleKeyPress);
  }, [viewMode, showResults, generatedQuiz, activeQuiz, currentQuestionIndex, practiceMode, handleSelectAnswer]);

  // =====================
  // VOICE FLASHCARD HELPERS (declare before navigation handlers)
  // =====================

  // Read current flashcard (front or back based on flip state)
  const readCurrentCard = useCallback(async () => {
    const cards = generatedFlashcards?.flashcards || activeFlashcardSet?.cards || [];
    const currentCard = cards[currentCardIndex];
    if (!currentCard || !voiceAgentRef.current || !isVoiceAgentOpen) return;

    // Stop any ongoing speech before reading new card
    voiceAgentRef.current.stopSpeaking();

    const cardNumber = currentCardIndex + 1;
    const totalCards = cards.length;

    if (!isFlipped) {
      // Read the front of the card
      const frontText = currentCard.front || currentCard.question || '';
      const text = `Card ${cardNumber} of ${totalCards}. ${frontText}`;
      await voiceAgentRef.current.speakText(text);
    } else {
      // Read the back of the card
      const backText = currentCard.back || currentCard.explanation || '';
      const topicText = currentCard.topic ? ` Topic: ${currentCard.topic}.` : '';
      const text = `Answer: ${backText}.${topicText}`;
      await voiceAgentRef.current.speakText(text);
    }
  }, [generatedFlashcards, activeFlashcardSet, currentCardIndex, isFlipped, isVoiceAgentOpen]);

  // Read just the front of the current card
  const readCardFront = useCallback(async () => {
    const cards = generatedFlashcards?.flashcards || activeFlashcardSet?.cards || [];
    const currentCard = cards[currentCardIndex];
    if (!currentCard || !voiceAgentRef.current || !isVoiceAgentOpen) return;

    // Stop any ongoing speech before reading
    voiceAgentRef.current.stopSpeaking();

    const frontText = currentCard.front || currentCard.question || '';
    await voiceAgentRef.current.speakText(frontText);
  }, [generatedFlashcards, activeFlashcardSet, currentCardIndex, isVoiceAgentOpen]);

  // Read just the back of the current card
  const readCardBack = useCallback(async () => {
    const cards = generatedFlashcards?.flashcards || activeFlashcardSet?.cards || [];
    const currentCard = cards[currentCardIndex];
    if (!currentCard || !voiceAgentRef.current || !isVoiceAgentOpen) return;

    // Stop any ongoing speech before reading
    voiceAgentRef.current.stopSpeaking();

    const backText = currentCard.back || currentCard.explanation || '';
    await voiceAgentRef.current.speakText(backText);
  }, [generatedFlashcards, activeFlashcardSet, currentCardIndex, isVoiceAgentOpen]);

  // Flashcard navigation
  const handleNextCard = useCallback(() => {
    const cards = generatedFlashcards?.flashcards || activeFlashcardSet?.cards || [];
    if (currentCardIndex < cards.length - 1) {
      setIsFlipped(false);
      // Flag for auto-read if voice agent is open (hands-free mode)
      if (isVoiceAgentOpen) {
        shouldAutoReadCardRef.current = true;
      }
      setCurrentCardIndex(prev => prev + 1);
    }
  }, [generatedFlashcards, activeFlashcardSet, currentCardIndex, isVoiceAgentOpen]);

  const handlePrevCard = useCallback(() => {
    if (currentCardIndex > 0) {
      setIsFlipped(false);
      // Flag for auto-read if voice agent is open (hands-free mode)
      if (isVoiceAgentOpen) {
        shouldAutoReadCardRef.current = true;
      }
      setCurrentCardIndex(prev => prev - 1);
    }
  }, [currentCardIndex, isVoiceAgentOpen]);

  // Mark current card as mastered and move to next
  const handleMarkMastered = useCallback(() => {
    const cards = generatedFlashcards?.flashcards || activeFlashcardSet?.cards || [];
    const currentCard = cards[currentCardIndex];
    if (!currentCard) return;

    const cardId = currentCard.id || `card-${currentCardIndex}`;
    setMasteredCards(prev => {
      const next = new Set(prev);
      next.add(cardId);
      return next;
    });
    // Remove from needs practice if it was there
    setNeedsPracticeCards(prev => {
      const next = new Set(prev);
      next.delete(cardId);
      return next;
    });

    // Move to next card
    if (currentCardIndex < cards.length - 1) {
      setIsFlipped(false);
      if (isVoiceAgentOpen) {
        shouldAutoReadCardRef.current = true;
      }
      setCurrentCardIndex(prev => prev + 1);
    }
  }, [generatedFlashcards, activeFlashcardSet, currentCardIndex, isVoiceAgentOpen]);

  // Mark current card as needs practice and move to next
  const handleMarkNeedsPractice = useCallback(() => {
    const cards = generatedFlashcards?.flashcards || activeFlashcardSet?.cards || [];
    const currentCard = cards[currentCardIndex];
    if (!currentCard) return;

    const cardId = currentCard.id || `card-${currentCardIndex}`;
    setNeedsPracticeCards(prev => {
      const next = new Set(prev);
      next.add(cardId);
      return next;
    });
    // Remove from mastered if it was there
    setMasteredCards(prev => {
      const next = new Set(prev);
      next.delete(cardId);
      return next;
    });

    // Move to next card
    if (currentCardIndex < cards.length - 1) {
      setIsFlipped(false);
      if (isVoiceAgentOpen) {
        shouldAutoReadCardRef.current = true;
      }
      setCurrentCardIndex(prev => prev + 1);
    }
  }, [generatedFlashcards, activeFlashcardSet, currentCardIndex, isVoiceAgentOpen]);

  // Save flashcard session when all cards have been reviewed
  const saveFlashcardSession = useCallback(async () => {
    const setId = generatedFlashcards?.flashcardSetId || activeFlashcardSetId;
    if (!setId || !userId || flashcardSessionSaved) return;

    const cards = generatedFlashcards?.flashcards || activeFlashcardSet?.cards || [];
    const cardsStudied = masteredCards.size + needsPracticeCards.size;
    const cardsMastered = masteredCards.size;

    try {
      await practiceApi.recordFlashcardSession(setId, {
        userId,
        cardsStudied,
        cardsMastered,
      });
      setFlashcardSessionSaved(true);
      refreshPracticeOverview();
    } catch (err) {
      console.error('Failed to save flashcard session:', err);
    }
  }, [generatedFlashcards, activeFlashcardSetId, activeFlashcardSet, userId, masteredCards, needsPracticeCards, flashcardSessionSaved, refreshPracticeOverview]);

  const handleResetFlashcards = () => {
    setGeneratedFlashcards(null);
    setActiveFlashcardSet(null);
    setActiveFlashcardSetId(null);
    setCurrentCardIndex(0);
    setIsFlipped(false);
    setMasteredCards(new Set());
    setNeedsPracticeCards(new Set());
    setFlashcardSessionSaved(false);
    // Go back to folder view if we came from there
    setViewMode(previousView === 'folder' ? 'folder' : 'overview');
  };

  // Helper to get correct answer from either field format (backend may return either)
  const getCorrectAnswer = (q: Question): string | undefined => {
    const ans = q.correct_answer || q.correctAnswer;
    if (practiceMode === 'true_false' && ans) {
      const lower = String(ans).toLowerCase();
      if (lower === 'true') return 'A';
      if (lower === 'false') return 'B';
    }
    return ans;
  };

  // Calculate quiz score
  const calculateScore = () => {
    const questions = generatedQuiz?.questions || activeQuiz?.questions || [];
    if (questions.length === 0) return { correct: 0, total: 0, percentage: 0 };
    let correct = 0;
    questions.forEach((q, idx) => {
      // Ensure consistent ID handling - match how IDs are created in the UI
      const questionId = q.id ? String(q.id) : `q-${idx}`;
      const userAnswer = selectedAnswers[questionId];
      const correctAnswer = getCorrectAnswer(q);
      // Only count as correct if user answered AND the answer is correct
      if (userAnswer !== undefined && userAnswer !== null && userAnswer !== '' && userAnswer === correctAnswer) {
        correct++;
      }
    });
    return {
      correct,
      total: questions.length,
      percentage: Math.round((correct / questions.length) * 100)
    };
  };

  // =====================
  // VOICE QUIZ HELPERS
  // =====================
  
  // Format question text for voice reading
  const formatQuestionForVoice = useCallback((question: Question, questionNumber: number, totalQuestions: number): string => {
    let text = `Question ${questionNumber} of ${totalQuestions}. ${question.question}`;
    return text;
  }, []);

  // Format answer options for voice reading
  const formatAnswersForVoice = useCallback((question: Question): string => {
    if (!question.options) return '';
    const optionTexts = Object.entries(question.options)
      .map(([key, value]) => `${key}: ${value}`)
      .join('. ');
    return `The options are: ${optionTexts}`;
  }, []);

  // Read current question and answers aloud
  const readCurrentQuestion = useCallback(async () => {
    const questions = generatedQuiz?.questions || activeQuiz?.questions || [];
    const currentQuestion = questions[currentQuestionIndex];
    if (!currentQuestion || !voiceAgentRef.current || !isVoiceAgentOpen) return;

    // Stop any ongoing speech before reading new question
    voiceAgentRef.current.stopSpeaking();

    const questionText = formatQuestionForVoice(currentQuestion, currentQuestionIndex + 1, questions.length);
    const answersText = formatAnswersForVoice(currentQuestion);
    const fullText = `${questionText} ${answersText}`;

    await voiceAgentRef.current.speakText(fullText);
  }, [generatedQuiz, activeQuiz, currentQuestionIndex, isVoiceAgentOpen, formatQuestionForVoice, formatAnswersForVoice]);

  // Read just the question
  const readQuestionOnly = useCallback(async () => {
    const questions = generatedQuiz?.questions || activeQuiz?.questions || [];
    const currentQuestion = questions[currentQuestionIndex];
    if (!currentQuestion || !voiceAgentRef.current || !isVoiceAgentOpen) return;

    // Stop any ongoing speech before reading
    voiceAgentRef.current.stopSpeaking();

    const questionText = formatQuestionForVoice(currentQuestion, currentQuestionIndex + 1, questions.length);
    await voiceAgentRef.current.speakText(questionText);
  }, [generatedQuiz, activeQuiz, currentQuestionIndex, isVoiceAgentOpen, formatQuestionForVoice]);

  // Read just the answers
  const readAnswersOnly = useCallback(async () => {
    const questions = generatedQuiz?.questions || activeQuiz?.questions || [];
    const currentQuestion = questions[currentQuestionIndex];
    if (!currentQuestion || !voiceAgentRef.current || !isVoiceAgentOpen) return;

    // Stop any ongoing speech before reading
    voiceAgentRef.current.stopSpeaking();

    const answersText = formatAnswersForVoice(currentQuestion);
    await voiceAgentRef.current.speakText(answersText);
  }, [generatedQuiz, activeQuiz, currentQuestionIndex, isVoiceAgentOpen, formatAnswersForVoice]);

  // Find next unanswered question index (returns -1 if all answered)
  const findNextUnansweredQuestion = useCallback((startIndex: number): number => {
    const questions = generatedQuiz?.questions || activeQuiz?.questions || [];
    const totalQuestions = questions.length;
    
    // Search from startIndex to end
    for (let i = startIndex; i < totalQuestions; i++) {
      const q = questions[i];
      const questionId = q.id ? String(q.id) : `q-${i}`;
      const answer = selectedAnswers[questionId];
      if (answer === undefined || answer === null || answer === '') {
        return i;
      }
    }
    
    // Wrap around and search from 0 to startIndex
    for (let i = 0; i < startIndex; i++) {
      const q = questions[i];
      const questionId = q.id ? String(q.id) : `q-${i}`;
      const answer = selectedAnswers[questionId];
      if (answer === undefined || answer === null || answer === '') {
        return i;
      }
    }
    
    return -1; // All questions answered
  }, [generatedQuiz, activeQuiz, selectedAnswers]);

  // Check if all questions are answered
  const areAllQuestionsAnswered = useCallback((): boolean => {
    const questions = generatedQuiz?.questions || activeQuiz?.questions || [];
    return questions.every((q, idx) => {
      const questionId = q.id ? String(q.id) : `q-${idx}`;
      const answer = selectedAnswers[questionId];
      return answer !== undefined && answer !== null && answer !== '';
    });
  }, [generatedQuiz, activeQuiz, selectedAnswers]);

  // Move to next unanswered question or submit if all answered (for voice mode)
  const moveToNextOrSubmit = useCallback(async () => {
    const nextUnanswered = findNextUnansweredQuestion(currentQuestionIndex + 1);

    if (nextUnanswered === -1) {
      // All questions answered - submit the quiz
      if (voiceAgentRef.current && isVoiceAgentOpen) {
        await voiceAgentRef.current.speakText("All questions answered. Submitting your quiz.");
      }
      handleSubmitQuiz();
    } else {
      // Move to next unanswered question and flag for auto-read
      shouldAutoReadQuestionRef.current = true;
      setCurrentQuestionIndex(nextUnanswered);
    }
  }, [findNextUnansweredQuestion, currentQuestionIndex, isVoiceAgentOpen, handleSubmitQuiz]);

  // Render folder tree item for generation
  const renderFolderTree = (folder: Folder, depth = 0) => {
    const isSelected = isFolderSelected(folder.id);
    const isDirectlySelected = selectedFolders.has(folder.id);
    const isSelectedViaParent = isSelected && !isDirectlySelected;
    const isExpanded = expandedFolders.has(folder.id);
    const hasContent = folder.sections.length > 0 || folder.subfolders.length > 0;

    const countFiles = (f: Folder): number => {
      let count = f.sections.reduce((acc, s) => acc + s.files.length, 0);
      count += f.subfolders.reduce((acc, sf) => acc + countFiles(sf), 0);
      return count;
    };
    const fileCount = countFiles(folder);

    return (
      <div key={folder.id}>
        <div
          className={`flex items-center gap-3 px-3 py-2 transition border-l-2 ${
            isSelected
              ? 'border-indigo-500'
              : 'border-transparent hover:bg-slate-800/30'
          } ${isSelectedViaParent ? 'opacity-60' : ''}`}
          style={{ paddingLeft: `${depth * 20 + 12}px` }}
        >
          <button
            onClick={(e) => {
              e.stopPropagation();
              toggleExpand(folder.id);
            }}
            className={`w-5 h-5 flex items-center justify-center text-slate-500 hover:text-white transition cursor-pointer ${
              !hasContent ? 'invisible' : ''
            }`}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className={`h-4 w-4 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>

          <button
            onClick={() => !isSelectedViaParent && toggleFolderSelection(folder.id)}
            disabled={isSelectedViaParent}
            className={`w-5 h-5 border flex items-center justify-center transition ${
              isSelected
                ? 'bg-indigo-600 border-indigo-600'
                : 'border-slate-600 hover:border-slate-400'
            } ${isSelectedViaParent ? 'cursor-not-allowed' : 'cursor-pointer'}`}
          >
            {isSelected && (
              <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3 text-white" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
              </svg>
            )}
          </button>

          <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-amber-500" fill="currentColor" viewBox="0 0 24 24">
            <path d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z" />
          </svg>

          <div 
            className={`flex-1 min-w-0 ${isSelectedViaParent ? '' : 'cursor-pointer'}`}
            onClick={() => !isSelectedViaParent && toggleFolderSelection(folder.id)}
          >
            <span className="text-white font-medium">{folder.name}</span>
            <span className="text-slate-500 text-sm ml-2">
              {fileCount} file{fileCount !== 1 ? 's' : ''}
            </span>
            {isSelectedViaParent && (
              <span className="text-indigo-400 text-xs ml-2">(included in parent)</span>
            )}
          </div>
        </div>

        {isExpanded && (
          <div>
            {folder.sections.map(section => renderMaterialItem(section, depth + 1, folder.id))}
            {folder.subfolders.map(subfolder => renderFolderTree(subfolder, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  // Render material item for generation
  // - If parent folder is selected: shows as selected, can't be toggled individually
  // - If parent folder is NOT selected: can be individually selected
  // - Expand arrow only expands, doesn't select
  // - Clicking checkbox or row selects and auto-expands
  // - Shows file selection when material is expanded
  // - Shows topics/chapters when file is expanded
  const renderMaterialItem = (section: MaterialSection, depth: number, parentFolderId: string) => {
    const isParentSelected = isMaterialSelectionDisabled(parentFolderId);
    const isSelected = isMaterialSelected(section.id, parentFolderId);
    const isMaterialExpanded = expandedMaterials.has(section.id);
    
    // Get structure info for this section
    const structure = sectionStructures.get(section.id);
    const hasFiles = structure?.materials && structure.materials.length > 0;
    const sectionSelectedFiles = selectedFiles.get(section.id);
    const selectedFileCount = sectionSelectedFiles?.size || 0;
    const totalFiles = structure?.materials?.length || section.files.length;

    const handleMaterialSelect = (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!isParentSelected) {
        toggleMaterialSelection(section.id);
        // Auto-expand when selecting
        if (!isSelected && hasFiles) {
          setExpandedMaterials(prev => new Set(prev).add(section.id));
        }
      }
    };
    
    const handleExpandClick = (e: React.MouseEvent) => {
      e.stopPropagation();
      toggleMaterialExpansion(section.id);
    };

    return (
      <div key={section.id}>
        <div
          className={`flex items-center gap-3 px-3 py-2 transition border-l-2 ${
            isSelected 
              ? isParentSelected 
                ? 'border-indigo-500/50 opacity-60' 
                : 'border-indigo-500'
              : 'border-transparent hover:bg-slate-800/30'
          } ${isParentSelected ? 'cursor-not-allowed' : ''}`}
          style={{ paddingLeft: `${depth * 20 + 12}px` }}
        >
          {/* Expand arrow for materials with files - only expands, doesn't select */}
          {hasFiles ? (
            <button
              onClick={handleExpandClick}
              className="w-5 h-5 flex items-center justify-center text-slate-400 hover:text-white transition cursor-pointer"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className={`h-4 w-4 transition-transform ${isMaterialExpanded ? 'rotate-90' : ''}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          ) : (
            <div className="w-5" />
          )}

          <button
            type="button"
            onClick={handleMaterialSelect}
            disabled={isParentSelected}
            className={`w-5 h-5 border flex items-center justify-center transition flex-shrink-0 ${
              isSelected
                ? isParentSelected
                  ? 'bg-indigo-600/50 border-indigo-600/50 cursor-not-allowed'
                  : 'bg-indigo-600 border-indigo-600 cursor-pointer'
                : 'border-slate-600 hover:border-slate-400 cursor-pointer'
            }`}
          >
            {isSelected && (
              <svg xmlns="http://www.w3.org/2000/svg" className={`h-3 w-3 ${isParentSelected ? 'text-white/70' : 'text-white'}`} viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
              </svg>
            )}
          </button>

          <svg xmlns="http://www.w3.org/2000/svg" className={`h-5 w-5 flex-shrink-0 ${isSelected ? 'text-slate-400' : 'text-slate-500'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
          </svg>

          <div className="flex-1 min-w-0 flex items-center gap-2">
            <span className={isSelected ? 'text-white' : 'text-slate-400'}>{section.title}</span>
            <span className="text-slate-600 text-sm">
              {totalFiles} file{totalFiles !== 1 ? 's' : ''}
            </span>
            {isParentSelected && isSelected && (
              <span className="text-indigo-400 text-xs">(included in folder)</span>
            )}
            {isSelected && selectedFileCount > 0 && selectedFileCount < totalFiles && (
              <span className="text-xs text-indigo-400">
                {selectedFileCount}/{totalFiles} files
              </span>
            )}
          </div>
        </div>
        
        {/* File selection - show when material is expanded and has files */}
        {hasFiles && isMaterialExpanded && structure?.materials && (
          <div 
            className="border-l border-slate-700"
            style={{ marginLeft: `${depth * 20 + 32}px` }}
          >
            {structure.materials.map(material => {
              const isFileSelected = sectionSelectedFiles?.has(material.id) || false;
              const hasChapters = material.hasChapters && material.chapters.length > 0;
              const isFileExpanded = expandedMaterials.has(`file-${material.id}`);
              const fileSelectedChapters = selectedChapters.get(material.id);
              const selectedChapterCount = fileSelectedChapters?.size || 0;
              // Check if these are topics (generated) or chapters
              const areTopics = hasChapters && material.chapters.some(ch => ch.isGeneratedTopic);
              const itemLabel = areTopics ? 'topics' : 'chapters';

              const handleFileSelect = (e: React.MouseEvent) => {
                e.stopPropagation();
                toggleFileSelection(section.id, material.id, material.chapters || []);
                // Auto-expand when selecting if has chapters
                if (!isFileSelected && hasChapters) {
                  setExpandedMaterials(prev => new Set(prev).add(`file-${material.id}`));
                }
              };

              return (
                <div key={material.id}>
                  <div
                    className={`flex items-center gap-3 px-3 py-2 transition border-l-2 ${
                      isFileSelected ? 'border-indigo-500' : 'border-transparent hover:bg-slate-800/30'
                    }`}
                  >
                    {/* Expand arrow for files with chapters - only expands, doesn't select */}
                    {hasChapters ? (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setExpandedMaterials(prev => {
                            const next = new Set(prev);
                            const key = `file-${material.id}`;
                            if (next.has(key)) {
                              next.delete(key);
                            } else {
                              next.add(key);
                            }
                            return next;
                          });
                        }}
                        className="w-5 h-5 flex items-center justify-center text-slate-400 hover:text-white transition cursor-pointer"
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          className={`h-4 w-4 transition-transform ${isFileExpanded ? 'rotate-90' : ''}`}
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                      </button>
                    ) : (
                      <div className="w-5" />
                    )}

                    <button
                      type="button"
                      className={`w-5 h-5 border flex items-center justify-center transition flex-shrink-0 cursor-pointer ${
                        isFileSelected
                          ? 'bg-indigo-600 border-indigo-600'
                          : 'border-slate-600 hover:border-slate-400'
                      }`}
                      onClick={handleFileSelect}
                    >
                      {isFileSelected && (
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3 text-white" viewBox="0 0 20 20" fill="currentColor">
                          <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                        </svg>
                      )}
                    </button>

                    <svg xmlns="http://www.w3.org/2000/svg" className={`h-5 w-5 flex-shrink-0 ${isFileSelected ? 'text-slate-400' : 'text-slate-500'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>

                    <div className="flex-1 min-w-0 flex items-center gap-2">
                      <span className={isFileSelected ? 'text-white' : 'text-slate-400'} title={material.fileName}>
                        {material.title || material.fileName}
                      </span>
                      {hasChapters && (
                        <span className="text-slate-500 text-xs">
                          {material.chapters.length} {itemLabel}
                        </span>
                      )}
                      {isFileSelected && hasChapters && selectedChapterCount > 0 && selectedChapterCount < material.chapters.length && (
                        <span className="text-xs text-indigo-400">
                          {selectedChapterCount}/{material.chapters.length} {itemLabel}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Topic/Chapter selection - show when file is expanded and has chapters */}
                  {hasChapters && isFileExpanded && (
                    <div 
                      className="border-l border-slate-700"
                      style={{ marginLeft: `20px` }}
                    >
                      <div className="px-4 py-1.5 border-b border-slate-800 flex items-center justify-between">
                        <span className="text-xs text-slate-500">{areTopics ? 'Topics' : 'Chapters'}</span>
                        <div className="flex gap-2">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              selectAllChapters(material.id, material.chapters);
                              // Also ensure file and material are selected (without re-selecting chapters)
                              if (!sectionSelectedFiles?.has(material.id)) {
                                setSelectedFiles(prevFiles => {
                                  const nextFiles = new Map(prevFiles);
                                  const currentFilesSet = nextFiles.get(section.id) || new Set<string>();
                                  const newFilesSet = new Set(currentFilesSet);
                                  newFilesSet.add(material.id);
                                  nextFiles.set(section.id, newFilesSet);
                                  return nextFiles;
                                });
                              }
                              if (!selectedMaterials.has(section.id)) {
                                setSelectedMaterials(prevMats => {
                                  const nextMats = new Set(prevMats);
                                  nextMats.add(section.id);
                                  return nextMats;
                                });
                              }
                            }}
                            className="text-xs text-indigo-400 hover:text-indigo-300 cursor-pointer"
                          >
                            All
                          </button>
                          <span className="text-slate-600">|</span>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              clearChapterSelection(material.id);
                            }}
                            className="text-xs text-slate-400 hover:text-white cursor-pointer"
                          >
                            None
                          </button>
                        </div>
                      </div>
                      <div className="max-h-40 overflow-y-auto">
                        {material.chapters.map(chapter => {
                          const isChapterSelected = fileSelectedChapters?.has(chapter.number) || false;
                          return (
                            <label
                              key={chapter.number}
                              className="flex items-center gap-3 px-4 py-1.5 hover:bg-slate-800/30 cursor-pointer group"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <input
                                type="checkbox"
                                checked={isChapterSelected}
                                onChange={() => toggleChapterSelection(section.id, material.id, chapter.number, material.chapters.length)}
                                className="w-4 h-4 border-slate-600 bg-transparent text-indigo-600 focus:ring-indigo-500 focus:ring-offset-0 cursor-pointer"
                              />
                              <div className="flex-1 min-w-0 flex items-center gap-2">
                                <span className="text-sm text-slate-300 group-hover:text-white transition">
                                  {chapter.isGeneratedTopic ? '' : `Ch ${chapter.number}: `}{chapter.title}
                                </span>
                                <span className="text-xs text-slate-500">({chapter.percentage})</span>
                              </div>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  // Format date helper
  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  // Build context for voice agent
  const getVoiceAgentContext = () => {
    const baseContext: any = {
      viewMode,
    };

    if (viewMode === 'quiz' && (generatedQuiz || activeQuiz)) {
      const questions = generatedQuiz?.questions || activeQuiz?.questions || [];
      const currentQuestion = questions[currentQuestionIndex];
      const currentQuestionId = currentQuestion?.id ? String(currentQuestion.id) : `q-${currentQuestionIndex}`;
      
      baseContext.currentQuestion = currentQuestion;
      baseContext.currentQuestionIndex = currentQuestionIndex;
      baseContext.totalQuestions = questions.length;
      baseContext.userAnswer = selectedAnswers[currentQuestionId];
      baseContext.showResults = showResults;
      baseContext.quizName = generatedQuiz?.name || activeQuiz?.name || 'Quiz';
      
      if (showResults) {
        baseContext.score = calculateScore();
        
        // Build detailed results for each question
        baseContext.questionResults = questions.map((q, idx) => {
          const questionId = q.id ? String(q.id) : `q-${idx}`;
          const userAnswer = selectedAnswers[questionId];
          const correctAnswer = getCorrectAnswer(q);
          const isAnswered = userAnswer !== undefined && userAnswer !== null && userAnswer !== '';
          const isCorrect = isAnswered && userAnswer === correctAnswer;
          
          // Get the text of the user's answer and correct answer
          const getUserAnswerText = () => {
            if (!isAnswered) return 'Not answered';
            if (q.options && typeof q.options === 'object') {
              return (q.options as Record<string, string>)[userAnswer] || userAnswer;
            }
            return userAnswer;
          };
          
          const getCorrectAnswerText = () => {
            if (q.options && typeof q.options === 'object' && correctAnswer) {
              return (q.options as Record<string, string>)[correctAnswer] || correctAnswer;
            }
            return correctAnswer || 'Unknown';
          };
          
          return {
            questionNumber: idx + 1,
            questionText: q.question,
            userAnswer: getUserAnswerText(),
            correctAnswer: getCorrectAnswerText(),
            isCorrect,
            isAnswered,
            explanation: q.explanation || null,
          };
        });
        
        // Summary of incorrect questions for easy reference
        baseContext.incorrectQuestions = baseContext.questionResults
          .filter((r: any) => !r.isCorrect)
          .map((r: any) => ({
            questionNumber: r.questionNumber,
            questionText: r.questionText,
            userAnswer: r.userAnswer,
            correctAnswer: r.correctAnswer,
            explanation: r.explanation,
          }));
        
        baseContext.correctQuestions = baseContext.questionResults
          .filter((r: any) => r.isCorrect)
          .map((r: any) => r.questionNumber);
      }
    } else if (viewMode === 'flashcards' && (generatedFlashcards || activeFlashcardSet)) {
      const cards = generatedFlashcards?.flashcards || activeFlashcardSet?.cards || [];
      baseContext.currentCard = cards[currentCardIndex];
      baseContext.currentCardIndex = currentCardIndex;
      baseContext.totalCards = cards.length;
      baseContext.isFlipped = isFlipped;
    } else if (viewMode === 'overview' && practiceOverview) {
      baseContext.stats = {
        totalQuizzes: practiceOverview.quizzes.length,
        totalFlashcards: practiceOverview.flashcardSets.length,
        totalFolders: practiceOverview.folders.length,
      };
    }

    return baseContext;
  };

  // Handle voice actions from VoiceAgent
  const handleVoiceAction = useCallback(async (action: VoiceAction) => {
    console.log('Handling voice action:', action);

    switch (action.type) {
      case 'GENERATE_QUIZ': {
        const { questionCount, sectionIds, folderId, materialName, folderName } = action.params;
        
        // If we have section IDs directly, use them
        if (sectionIds && sectionIds.length > 0) {
          // Set up for generation
          const parsedCount = questionCount || 20;
          setSetSize(parsedCount.toString());
          
          // Trigger generation with the provided section IDs
          setIsGenerating(true);
          setError(null);
          
          const baseName = materialName || folderName || `Practice Set - ${new Date().toISOString().split('T')[0]}`;
          
          try {
            // Generate based on selected generation type (defaults to multiple_choice)
            const genType = selectedGenerationType;
            
            if (genType === 'multiple_choice' || genType === 'true_false') {
              setGenerationStatus(`Generating ${genType === 'multiple_choice' ? 'Multiple Choice' : 'True/False'} questions...`);
              const quiz = await practiceApi.generateQuiz({
                sectionIds,
                userId: userId!,
                questionCount: parsedCount,
                questionType: genType,
                difficulty: 'mixed',
                name: baseName,
                folderId: folderId || undefined,
                onProgress: (msg) => setGenerationStatus(msg),
              });
              
              setGenerationStatus('');
              setGeneratedQuiz(quiz);
              setGeneratedFlashcards(null);
              setCurrentQuestionIndex(0);
              setSelectedAnswers({});
              setShowResults(false);
              setQuizStartTime(Date.now());
              setPracticeMode(genType);
              setViewMode('quiz');
            } else {
              // Flashcards
              setGenerationStatus('Generating flashcards...');
              const flashcardSet = await practiceApi.generateFlashcards({
                sectionIds,
                userId: userId!,
                count: parsedCount,
                name: baseName,
                folderId: folderId || undefined,
              });
              
              setGenerationStatus('');
              setGeneratedFlashcards(flashcardSet);
              setGeneratedQuiz(null);
              setCurrentCardIndex(0);
              setIsFlipped(false);
              setViewMode('flashcards');
            }
            
            refreshPracticeOverview();
          } catch (err) {
            console.error('Voice-initiated quiz generation failed:', err);
            setError(err instanceof Error ? err.message : 'Failed to generate practice set');
          } finally {
            setIsGenerating(false);
          }
        } else {
          // No section IDs - prompt user to select materials
          setError('Please specify which material or folder to generate questions from. Try saying the exact name of your uploaded material.');
        }
        break;
      }

      case 'ANSWER_QUESTION': {
        if (viewMode === 'quiz' && !showResults) {
          const questions = generatedQuiz?.questions || activeQuiz?.questions || [];
          // Use the ref to get the CURRENT question index (not stale closure)
          const actualCurrentIndex = currentQuestionIndexRef.current;
          const currentQuestion = questions[actualCurrentIndex];
          if (currentQuestion) {
            const questionId = currentQuestion.id ? String(currentQuestion.id) : `q-${actualCurrentIndex}`;
            const answer = action.params.answer.toUpperCase();

            // Validate the answer is valid (A, B, C, D)
            if (['A', 'B', 'C', 'D'].includes(answer)) {
              // Store the answer in ref so the effect can use it
              lastAnsweredQuestionRef.current = { questionId, answer };

              // Record the answer immediately
              handleSelectAnswer(questionId, answer);

              // Announce the selection
              if (voiceAgentRef.current && isVoiceAgentOpen) {
                const optionText = currentQuestion.options?.[answer as keyof typeof currentQuestion.options] || answer;
                voiceAgentRef.current.speakText(`Selected ${answer}: ${optionText}.`);
              }

              // Set flag to auto-advance after state updates
              shouldAutoAdvanceRef.current = true;
            }
          }
        }
        break;
      }

      case 'NEXT_QUESTION': {
        if (viewMode === 'quiz' && !showResults) {
          // Flag for auto-read after navigation if voice agent is open
          if (isVoiceAgentOpen) {
            shouldAutoReadQuestionRef.current = true;
          }
          handleNextQuestion();
        }
        break;
      }

      case 'PREV_QUESTION': {
        if (viewMode === 'quiz' && !showResults) {
          handlePrevQuestion();
        }
        break;
      }

      case 'SUBMIT_QUIZ': {
        if (viewMode === 'quiz' && !showResults) {
          handleSubmitQuiz();
        }
        break;
      }

      case 'FLIP_CARD': {
        if (viewMode === 'flashcards') {
          // Flag for auto-read after flipping if voice agent is open
          if (isVoiceAgentOpen) {
            shouldAutoReadCardRef.current = true;
          }
          setIsFlipped(prev => !prev);
        }
        break;
      }

      case 'NEXT_CARD': {
        if (viewMode === 'flashcards') {
          handleNextCard();
        }
        break;
      }

      case 'PREV_CARD': {
        if (viewMode === 'flashcards') {
          handlePrevCard();
        }
        break;
      }

      case 'EXIT_PRACTICE': {
        if (viewMode === 'quiz' || viewMode === 'flashcards') {
          if (viewMode === 'quiz') {
            handleResetQuiz();
          } else {
            handleResetFlashcards();
          }
        }
        break;
      }

      case 'GO_TO_QUESTION': {
        if (viewMode === 'quiz' && !showResults) {
          const targetIndex = action.params.questionNumber - 1;
          const questions = generatedQuiz?.questions || activeQuiz?.questions || [];
          if (targetIndex >= 0 && targetIndex < questions.length) {
            // Flag for auto-read after navigation if voice agent is open
            if (isVoiceAgentOpen) {
              shouldAutoReadQuestionRef.current = true;
            }
            setCurrentQuestionIndex(targetIndex);
          }
        }
        break;
      }

      case 'REPEAT_QUESTION':
      case 'READ_CURRENT_QUESTION': {
        if (viewMode === 'quiz' && !showResults) {
          readCurrentQuestion();
        }
        break;
      }

      case 'REPEAT_ANSWERS': {
        if (viewMode === 'quiz' && !showResults) {
          readAnswersOnly();
        }
        break;
      }

      case 'SKIP_QUESTION': {
        if (viewMode === 'quiz' && !showResults) {
          // Mark current as skipped (don't answer) and move to next unanswered
          const nextUnanswered = findNextUnansweredQuestion(currentQuestionIndex + 1);

          if (nextUnanswered === -1 || nextUnanswered === currentQuestionIndex) {
            // No other unanswered questions or only current is unanswered
            if (voiceAgentRef.current && isVoiceAgentOpen) {
              voiceAgentRef.current.speakText("This is the only unanswered question. Please answer or submit the quiz.");
            }
          } else {
            if (voiceAgentRef.current && isVoiceAgentOpen) {
              voiceAgentRef.current.speakText("Skipping to the next question.").then(() => {
                // Flag for auto-read after the skip message finishes
                shouldAutoReadQuestionRef.current = true;
                setCurrentQuestionIndex(nextUnanswered);
              });
            } else {
              setCurrentQuestionIndex(nextUnanswered);
            }
          }
        }
        break;
      }

      case 'REPEAT_CARD': {
        if (viewMode === 'flashcards') {
          readCurrentCard();
        }
        break;
      }

      default:
        console.log('Unknown voice action:', action);
    }
  }, [
    viewMode, showResults, currentQuestionIndex, generatedQuiz, activeQuiz,
    userId, handleSelectAnswer, handleNextQuestion, handlePrevQuestion,
    handleSubmitQuiz, handleNextCard, handlePrevCard, handleResetQuiz,
    handleResetFlashcards, refreshPracticeOverview, isVoiceAgentOpen,
    readCurrentQuestion, readAnswersOnly, moveToNextOrSubmit, findNextUnansweredQuestion,
    readCurrentCard
  ]);

  if (isLoading && !practiceOverview) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="animate-spin h-8 w-8 border-2 border-white border-t-transparent rounded-full" />
      </div>
    );
  }

  // =====================
  // QUIZ VIEW
  // =====================
  if (viewMode === 'quiz' && (generatedQuiz || activeQuiz)) {
    const questions = generatedQuiz?.questions || activeQuiz?.questions || [];
    const quizName = generatedQuiz?.name || activeQuiz?.name || 'Practice Set';
    
    // For True/False mode, ensure proper options and answer mapping
    // Backend generates true/false questions with correct_answer as "true" or "false"
    const displayQuestions = practiceMode === 'true_false' 
      ? questions.map(q => {
          const answer = String(q.correct_answer || q.correctAnswer || '').toLowerCase();
          return {
            ...q,
            options: { A: 'True', B: 'False' } as Record<string, string>,
            // Map "true"/"false" answer to "A"/"B" for display
            correct_answer: answer === 'true' ? 'A' : answer === 'false' ? 'B' : (answer === 'a' ? 'A' : 'B')
          };
        })
      : questions;
    
    const currentQuestion = displayQuestions[currentQuestionIndex];
    const score = calculateScore();

    if (showResults) {
      return (
        <div className={`h-full overflow-auto -mt-4 transition-all duration-300 ${isVoiceAgentOpen ? 'mr-[400px]' : ''}`}>
          {/* Voice Agent Button - Overlaid on bottom nav */}
          {!isVoiceAgentOpen && (
            <button
              onClick={() => setIsVoiceAgentOpen(true)}
              className="fixed bottom-4 right-6 z-[60] w-16 h-16 bg-indigo-600 hover:bg-indigo-700 rounded-full shadow-lg hover:shadow-xl transition-all transform hover:scale-110 flex items-center justify-center group"
              aria-label="Open voice assistant"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-7 w-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              </svg>
            </button>
          )}

          <VoiceAgent
            ref={voiceAgentRef}
            context={getVoiceAgentContext()}
            userId={userId}
            isOpen={isVoiceAgentOpen}
            onClose={() => setIsVoiceAgentOpen(false)}
            onAction={handleVoiceAction}
          />

          <div className="w-full">
            <div className="mb-8 flex items-start justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-indigo-400">
                  {practiceMode === 'multiple_choice' ? 'Multiple Choice' : 'True/False'} • {quizStartTime ? 'Completed' : 'Best Score'}
                </p>
                <h1 className="mt-1 text-2xl font-semibold text-white">
                  {quizName}
                </h1>
                <div className="mt-4 flex items-center gap-4">
                  <div className="text-5xl font-bold text-white">{score.percentage}%</div>
                  <div>
                    <div className="text-slate-400">{quizStartTime ? 'Your Score' : 'Best Score'}</div>
                    <div className="text-white text-lg">{score.correct} / {score.total} correct</div>
                  </div>
                  {!quizStartTime && activeQuiz?.best_score !== undefined && activeQuiz.best_score !== score.percentage && (
                    <div className="text-slate-500 text-sm">
                      (Highest: {activeQuiz.best_score}%)
                    </div>
                  )}
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleResetQuiz}
                  className="flex items-center gap-2 border border-slate-600 px-3 py-1.5 text-sm text-slate-300 transition hover:border-white hover:text-white cursor-pointer"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                  </svg>
                  {previousView === 'folder' ? 'Back to Folder' : 'Back to Practice'}
                </button>
                <button
                  onClick={() => {
                    setSelectedAnswers({});
                    setCurrentQuestionIndex(0);
                    setShowResults(false);
                    setQuizStartTime(Date.now());
                  }}
                  className="flex items-center gap-2 bg-white px-3 py-1.5 text-sm text-black font-semibold transition hover:bg-slate-200 cursor-pointer"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  Practice Again
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4 mb-8">
              {questions.map((q, idx) => {
                // Ensure consistent ID handling - match how IDs are created in the quiz UI
                const questionId = q.id ? String(q.id) : `q-${idx}`;
                const userAnswer = selectedAnswers[questionId];
                const correctAnswer = getCorrectAnswer(q);
                // Question is only correct if answered AND answer matches
                const isAnswered = userAnswer !== undefined && userAnswer !== null && userAnswer !== '';
                const isCorrect = isAnswered && userAnswer === correctAnswer;
                return (
                  <div key={questionId} className="p-4 border border-slate-800">
                    <div className="flex items-start gap-3">
                      <span className={`flex-shrink-0 w-6 h-6 flex items-center justify-center text-sm ${isCorrect ? 'text-green-500' : 'text-red-500'}`}>
                        {isCorrect ? '✓' : '✗'}
                      </span>
                      <div className="flex-1">
                        <p className="text-white font-medium">Q{idx + 1}: {q.question}</p>
                        <div className="mt-2 text-sm">
                          <p className="text-slate-400">Your answer: <span className={isCorrect ? 'text-green-400' : 'text-red-400'}>{isAnswered ? `${userAnswer}: ${q.options?.[userAnswer as keyof typeof q.options]}` : 'Not answered'}</span></p>
                          {!isCorrect && correctAnswer && <p className="text-slate-400">Correct answer: <span className="text-green-400">{correctAnswer}: {q.options?.[correctAnswer as keyof typeof q.options]}</span></p>}
                        </div>
                        {q.explanation && (
                          <p className="mt-2 text-sm text-slate-500 italic">{q.explanation}</p>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      );
    }

    // Generate smart pagination - show first, last, and pages around current
    const getPaginationItems = () => {
      const total = questions.length;
      const current = currentQuestionIndex;
      const items: (number | 'ellipsis')[] = [];
      
      if (total <= 9) {
        // Show all if 9 or fewer
        for (let i = 0; i < total; i++) items.push(i);
      } else {
        // Always show first
        items.push(0);
        
        // Show ellipsis if current is far from start
        if (current > 3) {
          items.push('ellipsis');
        }
        
        // Show pages around current
        const start = Math.max(1, current - 2);
        const end = Math.min(total - 2, current + 2);
        
        for (let i = start; i <= end; i++) {
          if (!items.includes(i)) items.push(i);
        }
        
        // Show ellipsis if current is far from end
        if (current < total - 4) {
          items.push('ellipsis');
        }
        
        // Always show last
        if (!items.includes(total - 1)) items.push(total - 1);
      }
      
      return items;
    };

    return (
      <div className={`flex flex-col overflow-hidden transition-all duration-300 ${isVoiceAgentOpen ? 'mr-[400px]' : ''}`}>
        {/* Voice Agent Button - Overlaid on bottom nav */}
        <button
          onClick={() => setIsVoiceAgentOpen(true)}
          className={`fixed bottom-4 z-[60] w-16 h-16 bg-indigo-600 hover:bg-indigo-700 rounded-full shadow-lg hover:shadow-xl transition-all transform hover:scale-110 flex items-center justify-center group ${isVoiceAgentOpen ? 'right-[424px]' : 'right-6'}`}
          aria-label="Open voice assistant"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-7 w-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
          </svg>
        </button>

        <VoiceAgent
          ref={voiceAgentRef}
          context={getVoiceAgentContext()}
          userId={userId}
          isOpen={isVoiceAgentOpen}
          onClose={() => setIsVoiceAgentOpen(false)}
          onAction={handleVoiceAction}
        />

        {/* Question Overview Modal */}
        {showQuestionOverview && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowQuestionOverview(false)}>
            <div className="bg-black/30 backdrop-blur-md border border-white/10 p-4 max-w-xl w-full mx-4 max-h-[60vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-3 flex-shrink-0">
                <h2 className="text-sm font-semibold text-white">Question Overview</h2>
                <button
                  onClick={() => setShowQuestionOverview(false)}
                  className="text-slate-400 hover:text-white transition cursor-pointer"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <div className="flex items-center gap-3 mb-3 text-xs flex-shrink-0">
                <div className="flex items-center gap-1.5">
                  <span className="w-3 h-3 bg-indigo-600"></span>
                  <span className="text-slate-400">Current</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="w-3 h-3 bg-slate-700"></span>
                  <span className="text-slate-400">Answered</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="w-3 h-3 bg-slate-800 border border-slate-600"></span>
                  <span className="text-slate-400">Unanswered</span>
                </div>
              </div>
              <div className="overflow-y-auto flex-1">
                <div className="grid grid-cols-15 gap-1" style={{ gridTemplateColumns: 'repeat(15, minmax(0, 1fr))' }}>
                  {questions.map((q, idx) => {
                    const qId = q.id ? String(q.id) : `q-${idx}`;
                    const isAnswered = selectedAnswers[qId] !== undefined;
                    const isCurrent = idx === currentQuestionIndex;
                    return (
                      <button
                        key={idx}
                        onClick={() => {
                          setCurrentQuestionIndex(idx);
                          setShowQuestionOverview(false);
                        }}
                        className={`w-full aspect-square flex items-center justify-center text-xs font-medium transition cursor-pointer ${
                          isCurrent
                            ? 'bg-indigo-600 text-white'
                            : isAnswered
                              ? 'bg-slate-700 text-white hover:bg-slate-600'
                              : 'bg-slate-800 text-slate-500 hover:bg-slate-700 border border-slate-600'
                        }`}
                      >
                        {idx + 1}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="mt-3 pt-3 border-t border-white/10 flex-shrink-0">
                <p className="text-slate-400 text-xs">
                  {Object.keys(selectedAnswers).length} of {questions.length} answered
                </p>
              </div>
            </div>
          </div>
        )}

        <div className="w-full flex flex-col h-full overflow-hidden">
          <div className="mb-2 flex items-center justify-between flex-shrink-0">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-indigo-400">
                {practiceMode === 'multiple_choice' ? 'Multiple Choice' : 'True/False'}
              </p>
              <h1 className="mt-1 text-lg font-semibold text-white">
                {quizName}
              </h1>
            </div>
            <button
              onClick={handleResetQuiz}
              className="flex items-center gap-2 border border-white px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-white hover:text-black cursor-pointer"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
              {previousView === 'folder' ? 'Back to Folder' : 'Back to Practice'}
            </button>
          </div>

          <div className="h-1.5 bg-slate-800 mb-4 flex-shrink-0">
            <div 
              className="h-full bg-indigo-600 transition-all"
              style={{ width: `${((currentQuestionIndex + 1) / questions.length) * 100}%` }}
            />
          </div>

          <div className="border border-slate-800 bg-black p-4 sm:p-6 flex-1 overflow-y-auto min-h-0 flex flex-col mb-4">
            <div className="flex items-center justify-center mb-4 sm:mb-6" style={{ minHeight: '4rem' }}>
              <p className="text-base text-white leading-relaxed text-center line-clamp-3">{currentQuestion?.question}</p>
            </div>
            
            <div className="space-y-2 flex-1">
              {currentQuestion?.options && Object.entries(currentQuestion.options).map(([key, value]) => {
                // Ensure consistent ID handling
                const currentQuestionId = currentQuestion.id ? String(currentQuestion.id) : `q-${currentQuestionIndex}`;
                return (
                  <button
                    key={key}
                    onClick={() => handleSelectAnswer(currentQuestionId, key)}
                    className={`w-full text-left p-3 border transition cursor-pointer ${
                      selectedAnswers[currentQuestionId] === key
                        ? 'border-indigo-500 bg-indigo-900/30'
                        : 'border-slate-700 hover:border-slate-500'
                    }`}
                  >
                    <span className="font-semibold text-indigo-400 mr-2">{key}.</span>
                    <span className="text-white">{value}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex items-center justify-between flex-shrink-0 pt-2">
            <button
              onClick={handlePrevQuestion}
              disabled={currentQuestionIndex === 0}
              className="px-3 py-1.5 border border-slate-700 text-slate-400 hover:text-white hover:border-slate-500 disabled:opacity-50 disabled:cursor-not-allowed transition cursor-pointer text-sm"
            >
              ← Previous
            </button>
            
            <div className="flex items-center gap-1">
              {/* Smart pagination */}
              {getPaginationItems().map((item, idx) => {
                if (item === 'ellipsis') {
                  return (
                    <span key={`ellipsis-${idx}`} className="text-slate-500 px-1 text-sm">...</span>
                  );
                }
                const qId = questions[item]?.id ? String(questions[item].id) : `q-${item}`;
                const isAnswered = selectedAnswers[qId] !== undefined;
                return (
                  <button
                    key={item}
                    onClick={() => setCurrentQuestionIndex(item)}
                    className={`w-7 h-7 text-xs font-medium transition cursor-pointer ${
                      item === currentQuestionIndex
                        ? 'bg-indigo-600 text-white'
                        : isAnswered
                          ? 'bg-slate-700 text-white hover:bg-slate-600'
                          : 'bg-slate-800 text-slate-500 hover:bg-slate-700'
                    }`}
                  >
                    {item + 1}
                  </button>
                );
              })}
              
              {/* View all button */}
              <button
                onClick={() => setShowQuestionOverview(true)}
                className="ml-1 px-2 py-1 border border-slate-600 text-slate-400 hover:text-white hover:border-slate-400 transition cursor-pointer text-xs flex items-center gap-1"
                title="View all questions"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                </svg>
                All
              </button>
            </div>

            {currentQuestionIndex < questions.length - 1 ? (
              <button
                onClick={handleNextQuestion}
                className="px-3 py-1.5 bg-white text-black font-semibold hover:bg-slate-200 transition cursor-pointer text-sm"
              >
                Next →
              </button>
            ) : (
              <button
                onClick={handleSubmitQuiz}
                className="px-3 py-1.5 bg-green-600 text-white font-semibold hover:bg-green-500 transition cursor-pointer text-sm"
              >
                Submit
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // =====================
  // FLASHCARDS VIEW
  // =====================
  if (viewMode === 'flashcards' && (generatedFlashcards || activeFlashcardSet)) {
    const cards = generatedFlashcards?.flashcards || activeFlashcardSet?.cards || [];
    const setName = generatedFlashcards?.name || activeFlashcardSet?.name || 'Practice Set';
    const currentCard = cards[currentCardIndex];
    const currentCardId = currentCard?.id || `card-${currentCardIndex}`;
    const isCurrentCardMastered = masteredCards.has(currentCardId);
    const isCurrentCardNeedsPractice = needsPracticeCards.has(currentCardId);
    const totalReviewed = masteredCards.size + needsPracticeCards.size;
    const allCardsReviewed = totalReviewed === cards.length;
    const masteryPercentage = cards.length > 0 ? Math.round((masteredCards.size / cards.length) * 100) : 0;

    if (!currentCard) {
      return (
        <div className="h-full flex items-center justify-center">
          <div className="text-center">
            <p className="text-slate-400 mb-4">No flashcards found</p>
            <button
              onClick={handleResetFlashcards}
              className="flex items-center gap-2 border border-white px-4 py-2 text-sm font-semibold text-white transition hover:bg-white hover:text-black cursor-pointer mx-auto"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
              {previousView === 'folder' ? 'Back to Folder' : 'Back to Practice'}
            </button>
          </div>
        </div>
      );
    }

    // Show completion summary when all cards are reviewed
    if (allCardsReviewed) {
      // Auto-save session when all cards reviewed
      if (!flashcardSessionSaved) {
        saveFlashcardSession();
      }

      return (
        <div className="h-full overflow-auto -mt-4">
          <div className="max-w-2xl mx-auto">
            <div className="mb-8 flex items-start justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-indigo-400">
                  Flashcards • Completed
                </p>
                <h1 className="mt-1 text-2xl font-semibold text-white">
                  {setName}
                </h1>
                <div className="mt-4 flex items-center gap-4">
                  <div className="text-5xl font-bold text-white">{masteryPercentage}%</div>
                  <div>
                    <div className="text-slate-400">Mastery Rate</div>
                    <div className="text-white text-lg">{masteredCards.size} / {cards.length} mastered</div>
                  </div>
                </div>
              </div>
              <button
                onClick={handleResetFlashcards}
                className="flex items-center gap-2 border border-slate-600 px-3 py-1.5 text-sm text-slate-300 transition hover:border-white hover:text-white cursor-pointer"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
                {previousView === 'folder' ? 'Back to Folder' : 'Back to Practice'}
              </button>
            </div>

            {/* Stats cards */}
            <div className="grid grid-cols-2 gap-4 mb-8">
              <div className="p-6 border border-green-600/50 bg-green-900/20">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 flex items-center justify-center bg-green-600/30 rounded-full">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                  <div>
                    <div className="text-3xl font-bold text-green-400">{masteredCards.size}</div>
                    <div className="text-slate-400 text-sm">Mastered</div>
                  </div>
                </div>
              </div>
              <div className="p-6 border border-orange-600/50 bg-orange-900/20">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 flex items-center justify-center bg-orange-600/30 rounded-full">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-orange-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                  </div>
                  <div>
                    <div className="text-3xl font-bold text-orange-400">{needsPracticeCards.size}</div>
                    <div className="text-slate-400 text-sm">Need More Practice</div>
                  </div>
                </div>
              </div>
            </div>

            {/* Action buttons */}
            <div className="flex gap-4">
              <button
                onClick={() => {
                  setMasteredCards(new Set());
                  setNeedsPracticeCards(new Set());
                  setFlashcardSessionSaved(false);
                  setCurrentCardIndex(0);
                  setIsFlipped(false);
                }}
                className="flex-1 flex items-center justify-center gap-2 bg-white px-4 py-3 text-sm text-black font-semibold transition hover:bg-slate-200 cursor-pointer"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                Practice All Again
              </button>
              {needsPracticeCards.size > 0 && (
                <button
                  onClick={() => {
                    // Find first card that needs practice
                    const needsPracticeIndices: number[] = [];
                    cards.forEach((card, idx) => {
                      const cardId = card.id || `card-${idx}`;
                      if (needsPracticeCards.has(cardId)) {
                        needsPracticeIndices.push(idx);
                      }
                    });
                    if (needsPracticeIndices.length > 0) {
                      setMasteredCards(new Set());
                      setNeedsPracticeCards(new Set());
                      setFlashcardSessionSaved(false);
                      setCurrentCardIndex(needsPracticeIndices[0]);
                      setIsFlipped(false);
                    }
                  }}
                  className="flex-1 flex items-center justify-center gap-2 border border-orange-500 px-4 py-3 text-sm text-orange-400 font-semibold transition hover:bg-orange-900/30 cursor-pointer"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                  Practice Weak Cards ({needsPracticeCards.size})
                </button>
              )}
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className={`h-full overflow-auto -mt-4 transition-all duration-300 ${isVoiceAgentOpen ? 'mr-[400px]' : ''}`}>
        {/* Voice Agent Button - Overlaid on bottom nav */}
        <button
          onClick={() => setIsVoiceAgentOpen(true)}
          className={`fixed bottom-4 z-[60] w-16 h-16 bg-indigo-600 hover:bg-indigo-700 rounded-full shadow-lg hover:shadow-xl transition-all transform hover:scale-110 flex items-center justify-center group ${isVoiceAgentOpen ? 'right-[424px]' : 'right-6'}`}
          aria-label="Open voice assistant"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-7 w-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
          </svg>
        </button>

        <VoiceAgent
          ref={voiceAgentRef}
          context={getVoiceAgentContext()}
          userId={userId}
          isOpen={isVoiceAgentOpen}
          onClose={() => setIsVoiceAgentOpen(false)}
          onAction={handleVoiceAction}
        />

        <div className="max-w-2xl mx-auto">
          <div className="mb-6 flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-indigo-400">
                Flashcards • Card {currentCardIndex + 1} of {cards.length}
              </p>
              <h1 className="mt-1 text-xl font-semibold text-white">
                {setName}
              </h1>
            </div>
            <button
              onClick={handleResetFlashcards}
              className="flex items-center gap-2 border border-white px-4 py-2 text-sm font-semibold text-white transition hover:bg-white hover:text-black cursor-pointer"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
              {previousView === 'folder' ? 'Back to Folder' : 'Back to Practice'}
            </button>
          </div>

          {/* Mastery progress bar */}
          <div className="mb-6">
            <div className="flex items-center justify-between text-xs mb-1.5">
              <div className="flex items-center gap-3">
                <span className="text-slate-400">{totalReviewed} of {cards.length} reviewed</span>
                {totalReviewed > 0 && (
                  <span className="text-white font-medium">{masteryPercentage}% mastered</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 bg-green-500 rounded-full"></span>
                  <span className="text-green-400">{masteredCards.size}</span>
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 bg-orange-500 rounded-full"></span>
                  <span className="text-orange-400">{needsPracticeCards.size}</span>
                </span>
              </div>
            </div>
            <div className="h-2 bg-slate-800 overflow-hidden">
              <div 
                className="h-full bg-indigo-600 transition-all duration-300"
                style={{ width: `${(totalReviewed / cards.length) * 100}%` }}
              />
            </div>
          </div>

          <div 
            onClick={() => setIsFlipped(!isFlipped)}
            className="cursor-pointer perspective-1000"
          >
            <div className={`flashcard-inner ${isFlipped ? 'flipped' : ''}`} style={{ minHeight: '300px' }}>
              <div className="flashcard-front border border-slate-800 bg-black flex items-center justify-center p-8">
                <div className="text-center">
                  <p className="text-xs uppercase tracking-wide text-slate-500 mb-4">Front</p>
                  <p className="text-xl text-white">{currentCard.front || currentCard.question}</p>
                  <p className="mt-8 text-sm text-slate-500">Click to flip</p>
                </div>
              </div>
              <div className="flashcard-back border border-slate-800 bg-black flex items-center justify-center p-8">
                <div className="text-center">
                  <p className="text-xs uppercase tracking-wide text-slate-500 mb-4">Back</p>
                  <p className="text-xl text-white">{currentCard.back || currentCard.explanation}</p>
                  {currentCard.topic && (
                    <p className="mt-4 text-sm text-indigo-400">Topic: {currentCard.topic}</p>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Mastery buttons container - always rendered to prevent layout shift */}
          <div className="mt-6 relative" style={{ minHeight: '52px' }}>
            {/* Buttons - invisible when not flipped or already reviewed */}
            <div className={`flex gap-4 transition-opacity duration-200 ${
              (!isFlipped || isCurrentCardMastered || isCurrentCardNeedsPractice) ? 'opacity-0 pointer-events-none' : 'opacity-100'
            }`}>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleMarkNeedsPractice();
                }}
                className="flex-1 flex items-center justify-center gap-2 border border-orange-500 px-4 py-3 text-sm text-orange-400 font-semibold transition hover:bg-orange-900/30 cursor-pointer"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                Need More Practice
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleMarkMastered();
                }}
                className="flex-1 flex items-center justify-center gap-2 bg-green-600 px-4 py-3 text-sm text-white font-semibold transition hover:bg-green-500 cursor-pointer"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                Mastered
              </button>
            </div>

            {/* Status overlay - shown when flipped and already reviewed */}
            <div className={`absolute inset-0 flex items-center justify-center transition-opacity duration-200 ${
              (isFlipped && (isCurrentCardMastered || isCurrentCardNeedsPractice)) ? 'opacity-100' : 'opacity-0 pointer-events-none'
            }`}>
              <div className={`w-full p-3 text-center text-sm ${
                isCurrentCardMastered 
                  ? 'bg-green-900/30 border border-green-600/50 text-green-400' 
                  : 'bg-orange-900/30 border border-orange-600/50 text-orange-400'
              }`}>
                {isCurrentCardMastered ? '✓ Marked as mastered' : '⚠ Marked as needs practice'}
                <button
                  onClick={() => {
                    // Clear the status to allow re-rating
                    if (isCurrentCardMastered) {
                      setMasteredCards(prev => {
                        const next = new Set(prev);
                        next.delete(currentCardId);
                        return next;
                      });
                    } else {
                      setNeedsPracticeCards(prev => {
                        const next = new Set(prev);
                        next.delete(currentCardId);
                        return next;
                      });
                    }
                  }}
                  className="ml-2 text-slate-400 hover:text-white underline"
                >
                  Change
                </button>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between mt-6">
            <button
              onClick={handlePrevCard}
              disabled={currentCardIndex === 0}
              className="px-4 py-2 border border-slate-700 text-slate-400 hover:text-white hover:border-slate-500 disabled:opacity-50 disabled:cursor-not-allowed transition cursor-pointer"
            >
              ← Previous
            </button>
            
            <div className="text-slate-400 text-sm">
              {currentCardIndex + 1} / {cards.length}
            </div>

            <button
              onClick={handleNextCard}
              disabled={currentCardIndex >= cards.length - 1}
              className="px-4 py-2 bg-white text-black font-semibold hover:bg-slate-200 disabled:opacity-50 disabled:cursor-not-allowed transition cursor-pointer"
            >
              Next →
            </button>
          </div>
        </div>
      </div>
    );
  }

  // =====================
  // GENERATE VIEW
  // =====================
  if (viewMode === 'generate') {
    return (
      <div className="h-full overflow-hidden -mt-4 flex flex-col">
        {error && (
          <div className="mb-4 bg-red-900/30 border border-red-500 px-4 py-3 text-red-300 flex justify-between items-center">
            <span>{error}</span>
            <button onClick={() => setError(null)} className="text-red-300 hover:text-red-100">×</button>
          </div>
        )}

        {/* Header */}
        <div className="mb-4 flex items-center justify-between flex-shrink-0">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-indigo-400">
              Create Practice Set
            </p>
            <h1 className="mt-1 text-2xl font-semibold text-white">
              Select materials and generate
            </h1>
          </div>
          <button
            onClick={() => setViewMode(previousView === 'folder' ? 'folder' : 'overview')}
            className="flex items-center gap-2 border border-white px-4 py-2 text-sm font-semibold text-white transition hover:bg-white hover:text-black cursor-pointer"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            {previousView === 'folder' ? 'Back to Folder' : 'Back to Overview'}
          </button>
        </div>

        {/* Settings bar - above the tree */}
        <div className="flex-shrink-0 mb-4 border border-slate-800 bg-black p-4">
          <div className="flex flex-wrap gap-4 items-end">
            {/* Generation type - horizontal pills */}
            <div className="flex-shrink-0">
              <label className="text-xs text-slate-400 block mb-2">Type</label>
              <div className="flex gap-1">
                <button
                  onClick={() => setSelectedGenerationType('multiple_choice')}
                  className={`px-3 py-1.5 text-sm font-medium transition cursor-pointer ${
                    selectedGenerationType === 'multiple_choice'
                      ? 'bg-blue-600 text-white'
                      : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-white'
                  }`}
                >
                  Multiple Choice
                </button>
                <button
                  onClick={() => setSelectedGenerationType('true_false')}
                  className={`px-3 py-1.5 text-sm font-medium transition cursor-pointer ${
                    selectedGenerationType === 'true_false'
                      ? 'bg-green-600 text-white'
                      : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-white'
                  }`}
                >
                  True/False
                </button>
                <button
                  onClick={() => setSelectedGenerationType('flashcards')}
                  className={`px-3 py-1.5 text-sm font-medium transition cursor-pointer ${
                    selectedGenerationType === 'flashcards'
                      ? 'bg-purple-600 text-white'
                      : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-white'
                  }`}
                >
                  Flashcards
                </button>
              </div>
            </div>

            {/* Name input */}
            <div className="flex-1 min-w-[200px]">
              <label className="text-xs text-slate-400 block mb-2">Name (optional)</label>
              <input
                type="text"
                value={practiceNameInput}
                onChange={(e) => setPracticeNameInput(e.target.value)}
                placeholder="Enter a name..."
                className="w-full bg-slate-900 border border-slate-700 px-3 py-1.5 text-white text-sm focus:outline-none focus:border-indigo-500"
              />
            </div>

            {/* Count input */}
            <div className="w-32">
              <label className="text-xs text-slate-400 block mb-2">
                {selectedGenerationType === 'flashcards' ? 'Cards' : 'Questions'}
              </label>
              <input
                type="number"
                value={setSize}
                onChange={(e) => setSetSize(e.target.value)}
                min="5"
                max="100"
                className="w-full bg-slate-900 border border-slate-700 px-3 py-1.5 text-white text-sm focus:outline-none focus:border-indigo-500"
              />
            </div>

            {/* Save to folder */}
            <div className="w-48">
              <label className="text-xs text-slate-400 block mb-2">Save to folder</label>
              <select
                value={saveToPracticeFolder || ''}
                onChange={(e) => setSaveToPracticeFolder(e.target.value || null)}
                className="w-full bg-slate-900 border border-slate-700 px-3 py-1.5 text-white text-sm focus:outline-none focus:border-indigo-500"
              >
                <option value="">No folder</option>
                {practiceOverview?.folders.map(folder => (
                  <option key={folder.id} value={folder.id}>{folder.name}</option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Material selection tree - takes up remaining space */}
        <div className="flex-1 flex flex-col border border-slate-800 bg-black overflow-hidden min-h-0">
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800 bg-slate-900/50 flex-shrink-0">
            <div className="text-sm text-slate-400">
              <span className="text-white font-medium">{totalSelectedCount}</span> item{totalSelectedCount !== 1 ? 's' : ''} selected
              {selectedFileCount > 0 && (
                <span className="ml-2">
                  (<span className="text-white">{selectedFileCount}</span> file{selectedFileCount !== 1 ? 's' : ''})
                </span>
              )}
              {hasChapterFilter && (
                <span className="ml-2 text-indigo-400">
                  • {Array.from(selectedChapters.values()).reduce((sum, s) => sum + s.size, 0)} chapter filter{Array.from(selectedChapters.values()).reduce((sum, s) => sum + s.size, 0) !== 1 ? 's' : ''}
                </span>
              )}
            </div>
            <div className="flex gap-2">
              {hasChapterFilter && (
                <>
                  <button 
                    onClick={() => setSelectedChapters(new Map())} 
                    className="text-xs text-indigo-400 hover:text-indigo-300 transition cursor-pointer"
                  >
                    Clear Chapters
                  </button>
                  <span className="text-slate-600">|</span>
                </>
              )}
              <button onClick={selectAll} className="text-xs text-slate-400 hover:text-white transition cursor-pointer">
                Select All
              </button>
              <span className="text-slate-600">|</span>
              <button onClick={clearSelection} className="text-xs text-slate-400 hover:text-white transition cursor-pointer">
                Clear
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            {materialFolders.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-center p-8">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12 text-slate-600 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                </svg>
                <p className="text-slate-400 mb-2">No materials yet</p>
                <p className="text-slate-500 text-sm">
                  Upload course materials first to generate practice content.
                </p>
                <a
                  href="/course-material"
                  className="mt-4 inline-block bg-white px-4 py-2 text-sm text-black font-semibold hover:bg-slate-200 transition cursor-pointer"
                >
                  Go to Course Materials
                </a>
              </div>
            ) : (
              <div className="py-2">
                {materialFolders.map(folder => renderFolderTree(folder))}
              </div>
            )}
          </div>
          
          {loadingStructures.size > 0 && (
            <div className="px-4 py-2 border-t border-slate-800 bg-slate-900/50 flex items-center gap-2 text-xs text-slate-400 flex-shrink-0">
              <div className="animate-spin h-3 w-3 border-2 border-slate-400 border-t-transparent rounded-full" />
              Loading chapter information...
            </div>
          )}
        </div>

        {/* Generate button - at the bottom */}
        <div className="flex-shrink-0 mt-4">
          <button
            onClick={handleGenerate}
            disabled={isGenerating || totalSelectedCount === 0}
            className="w-full bg-white py-3 text-black font-semibold transition hover:bg-slate-200 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer flex items-center justify-center gap-2"
          >
            {isGenerating ? (
              <>
                <div className="animate-spin h-4 w-4 border-2 border-black border-t-transparent rounded-full flex-shrink-0" />
                <span>{generationStatus || 'Generating...'}</span>
                <span className="text-black/50 font-normal">• Usually takes 1-2 minutes</span>
              </>
            ) : (
              <>
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
                {selectedGenerationType === 'multiple_choice' && 'Generate Multiple Choice'}
                {selectedGenerationType === 'true_false' && 'Generate True/False'}
                {selectedGenerationType === 'flashcards' && 'Generate Flashcards'}
              </>
            )}
          </button>
        </div>
      </div>
    );
  }

  // =====================
  // FOLDER DETAIL VIEW
  // =====================
  if (viewMode === 'folder' && activeFolderId) {
    const folder = getActiveFolder();
    const folderQuizzes = getFolderQuizzes();
    const folderFlashcards = getFolderFlashcardSets();

    if (!folder) {
      return (
        <div className="h-full flex items-center justify-center">
          <div className="text-center">
            <p className="text-slate-400 mb-4">Folder not found</p>
            <button
              onClick={() => {
                setActiveFolderId(null);
                setViewMode('overview');
              }}
              className="flex items-center gap-2 border border-white px-4 py-2 text-sm font-semibold text-white transition hover:bg-white hover:text-black cursor-pointer mx-auto"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
              Back to Practice
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="h-full overflow-auto -mt-4">
        {error && (
          <div className="mb-4 bg-red-900/30 border border-red-500 px-4 py-3 text-red-300 flex justify-between items-center">
            <span>{error}</span>
            <button onClick={() => setError(null)} className="text-red-300 hover:text-red-100">×</button>
          </div>
        )}

        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div 
              className="w-12 h-12 flex items-center justify-center border"
              style={{ borderColor: getFolderColor(folder.color) }}
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-7 w-7" fill={getFolderColor(folder.color)} viewBox="0 0 24 24">
                <path d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z" />
              </svg>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-indigo-400">
                Practice Folder
              </p>
              <h1 className="text-2xl font-semibold text-white">
                {folder.name}
              </h1>
              {folder.description && (
                <p className="text-slate-400 text-sm mt-0.5">{folder.description}</p>
              )}
            </div>
          </div>
          <button
            onClick={() => {
              setActiveFolderId(null);
              setViewMode('overview');
            }}
            className="flex items-center gap-2 border border-white px-4 py-2 text-sm font-semibold text-white transition hover:bg-white hover:text-black cursor-pointer"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Back to Practice
          </button>
        </div>

        {/* Practice Sets Section */}
        <div className="mb-8">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-white">
              Practice Sets ({folderQuizzes.length + folderFlashcards.length})
            </h2>
            <button
              onClick={() => handleGenerateFromFolder(folder.id)}
              className="bg-white px-4 py-1.5 text-sm text-black font-semibold hover:bg-slate-200 transition cursor-pointer flex items-center gap-2"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
              Create Practice Set
            </button>
          </div>

          {folderQuizzes.length === 0 && folderFlashcards.length === 0 ? (
            <div className="border border-dashed border-slate-700 bg-black p-8 text-center">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-10 w-10 text-slate-600 mx-auto mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
              <p className="text-slate-400 mb-2">No practice sets yet</p>
              <p className="text-slate-500 text-sm">Create a practice set from your course materials.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {folderQuizzes.map(quiz => {
                const score = quiz.best_score ?? 0;
                const circumference = 2 * Math.PI * 20;
                const strokeDashoffset = circumference - (score / 100) * circumference;
                
                return (
                  <div 
                    key={quiz.id} 
                    onClick={() => viewQuizResults(quiz.id, quiz.question_type || 'multiple_choice')}
                    className="group border border-slate-800 p-5 hover:border-slate-600 transition cursor-pointer"
                  >
                    <div className="flex items-center gap-4">
                      <div className="flex-shrink-0 w-10 h-10 flex items-center justify-center border border-slate-600">
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                        </svg>
                      </div>
                      <div className="flex-1 min-w-0">
                        <h3 className="text-white font-medium text-base">{quiz.name}</h3>
                        <p className="text-slate-500 text-sm mt-0.5">
                          {quiz.total_questions} questions • {formatDate(quiz.created_at)}
                        </p>
                      </div>
                      {/* Practice button - shows correct type based on quiz */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          loadQuiz(quiz.id, quiz.question_type || 'multiple_choice');
                        }}
                        className={`px-4 py-2 text-sm font-medium transition cursor-pointer border ${
                          quiz.question_type === 'true_false'
                            ? 'border-green-600 text-green-400 hover:bg-green-600 hover:text-white'
                            : 'border-blue-600 text-blue-400 hover:bg-blue-600 hover:text-white'
                        }`}
                      >
                        {quiz.question_type === 'true_false' ? 'Practice True/False' : 'Practice Multiple Choice'}
                      </button>
                      {/* Circular progress indicator */}
                      <div className="flex-shrink-0 relative w-14 h-14 flex items-center justify-center">
                        <svg className="w-14 h-14 transform -rotate-90">
                          <circle
                            cx="28"
                            cy="28"
                            r="20"
                            stroke="currentColor"
                            strokeWidth="4"
                            fill="none"
                            className="text-slate-800"
                          />
                          <circle
                            cx="28"
                            cy="28"
                            r="20"
                            stroke="currentColor"
                            strokeWidth="4"
                            fill="none"
                            strokeLinecap="round"
                            className="text-white"
                            style={{
                              strokeDasharray: circumference,
                              strokeDashoffset: strokeDashoffset,
                              transition: 'stroke-dashoffset 0.5s ease'
                            }}
                          />
                        </svg>
                        <div className="absolute inset-0 flex items-center justify-center">
                          <span className="text-white text-xs font-semibold">{score}%</span>
                        </div>
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteQuiz(quiz.id);
                        }}
                        className="opacity-0 group-hover:opacity-100 text-slate-500 hover:text-slate-300 transition cursor-pointer p-2"
                        title="Delete practice set"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                  </div>
                );
              })}
              {folderFlashcards.map(set => {
                const mastery = set.total_cards > 0 ? Math.round((set.mastery_count / set.total_cards) * 100) : 0;
                const circumference = 2 * Math.PI * 20;
                const strokeDashoffset = circumference - (mastery / 100) * circumference;
                
                return (
                  <div 
                    key={set.id} 
                    className="group border border-slate-800 p-5 hover:border-slate-600 transition"
                  >
                    <div className="flex items-center gap-4">
                      <div className="flex-shrink-0 w-10 h-10 flex items-center justify-center border border-slate-600">
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                        </svg>
                      </div>
                      <div className="flex-1 min-w-0">
                        <h3 className="text-white font-medium text-base">{set.name}</h3>
                        <p className="text-slate-500 text-sm mt-0.5">
                          {set.total_cards} cards • {formatDate(set.created_at)}
                        </p>
                      </div>
                      {/* Practice mode buttons */}
                      <div className="flex gap-2">
                        <button
                          onClick={() => loadFlashcardSet(set.id)}
                          className="px-3 py-1.5 text-xs font-medium border border-slate-600 text-slate-300 hover:bg-slate-800 hover:text-white transition cursor-pointer"
                        >
                          Study Flashcards
                        </button>
                      </div>
                      {/* Circular progress indicator */}
                      <div className="flex-shrink-0 relative w-14 h-14 flex items-center justify-center">
                        <svg className="w-14 h-14 transform -rotate-90">
                          <circle
                            cx="28"
                            cy="28"
                            r="20"
                            stroke="currentColor"
                            strokeWidth="4"
                            fill="none"
                            className="text-slate-800"
                          />
                          <circle
                            cx="28"
                            cy="28"
                            r="20"
                            stroke="currentColor"
                            strokeWidth="4"
                            fill="none"
                            strokeLinecap="round"
                            className="text-white"
                            style={{
                              strokeDasharray: circumference,
                              strokeDashoffset: strokeDashoffset,
                              transition: 'stroke-dashoffset 0.5s ease'
                            }}
                          />
                        </svg>
                        <div className="absolute inset-0 flex items-center justify-center">
                          <span className="text-white text-xs font-semibold">{mastery}%</span>
                        </div>
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteFlashcardSet(set.id);
                        }}
                        className="opacity-0 group-hover:opacity-100 text-slate-500 hover:text-slate-300 transition cursor-pointer p-2"
                        title="Delete flashcard set"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  }

  // =====================
  // OVERVIEW VIEW (Default)
  // =====================
  return (
    <div className="h-full overflow-auto -mt-4">
      {error && (
        <div className="mb-4 bg-red-900/30 border border-red-500 px-4 py-3 text-red-300 flex justify-between items-center">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="text-red-300 hover:text-red-100">×</button>
        </div>
      )}

      {/* Header */}
      <div className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-wide text-indigo-400">
          Practice Mode
        </p>
        <h1 className="mt-1 text-2xl font-semibold text-white">
          Your Practice Library
        </h1>
      </div>

      {/* Focus Areas - Topics that need more practice */}
      {topicAnalysis && topicAnalysis.focusAreas.length > 0 && (
        <div className="mb-8">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 flex items-center justify-center bg-orange-600/20 border border-orange-600/50 rounded-full">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-orange-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
              </div>
              <div>
                <h2 className="text-lg font-semibold text-white">Focus Areas</h2>
                <p className="text-slate-400 text-sm">Topics where you need more practice based on your quiz performance</p>
              </div>
            </div>
            {topicAnalysis.summary.overallAccuracy !== null && (
              <div className="text-right">
                <div className="text-2xl font-bold text-white">{topicAnalysis.summary.overallAccuracy}%</div>
                <div className="text-xs text-slate-400">Overall Accuracy</div>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {topicAnalysis.focusAreas.map((topic, index) => {
              // Color based on accuracy
              const getAccuracyColor = (acc: number) => {
                if (acc < 40) return { bg: 'bg-red-900/30', border: 'border-red-600/50', text: 'text-red-400', bar: 'bg-red-500' };
                if (acc < 60) return { bg: 'bg-orange-900/30', border: 'border-orange-600/50', text: 'text-orange-400', bar: 'bg-orange-500' };
                return { bg: 'bg-yellow-900/30', border: 'border-yellow-600/50', text: 'text-yellow-400', bar: 'bg-yellow-500' };
              };
              const colors = getAccuracyColor(topic.accuracy);

              return (
                <div 
                  key={`${topic.topic}-${index}`}
                  className={`${colors.bg} ${colors.border} border p-4 transition hover:border-opacity-80`}
                >
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex-1 min-w-0">
                      <h3 className="text-white font-medium text-sm truncate" title={topic.topic}>
                        {topic.topic}
                      </h3>
                      {topic.chapter && (
                        <p className="text-slate-500 text-xs mt-0.5">Chapter {topic.chapter}</p>
                      )}
                    </div>
                    <div className={`${colors.text} text-xl font-bold ml-3`}>
                      {topic.accuracy}%
                    </div>
                  </div>

                  {/* Progress bar */}
                  <div className="h-1.5 bg-slate-800/50 rounded-full overflow-hidden mb-2">
                    <div 
                      className={`h-full ${colors.bar} transition-all`}
                      style={{ width: `${topic.accuracy}%` }}
                    />
                  </div>

                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-400">
                      {topic.correctCount}/{topic.totalAttempts} correct
                    </span>
                    {topic.lastPracticed && (
                      <span className="text-slate-500">
                        Last: {new Date(topic.lastPracticed).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Summary stats */}
          <div className="mt-4 flex items-center gap-6 text-sm">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 bg-orange-500 rounded-full"></span>
              <span className="text-slate-400">{topicAnalysis.summary.weakTopicsCount} topics need work</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 bg-green-500 rounded-full"></span>
              <span className="text-slate-400">{topicAnalysis.summary.strongTopicsCount} topics mastered</span>
            </div>
            <div className="text-slate-500">
              {topicAnalysis.summary.totalTopics} topics tracked
            </div>
          </div>
        </div>
      )}

      {/* Show loading state for topic analysis */}
      {isLoadingTopicAnalysis && !topicAnalysis && (
        <div className="mb-8 p-6 border border-slate-800 bg-slate-900/30">
          <div className="flex items-center gap-3">
            <div className="animate-spin h-5 w-5 border-2 border-indigo-500 border-t-transparent rounded-full" />
            <span className="text-slate-400">Analyzing your practice performance...</span>
          </div>
        </div>
      )}

      {/* Practice Folders */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-white">Practice Folders</h2>
        </div>

        <div className="space-y-3">
          {practiceOverview?.folders.map(folder => {
            // Calculate folder stats from quizzes and flashcards
            const folderQuizzes = practiceOverview.quizzes.filter(q => q.folder_id === folder.id);
            const folderFlashcards = practiceOverview.flashcardSets.filter(f => f.folder_id === folder.id);
            const setCount = folderQuizzes.length + folderFlashcards.length;
            
            // Calculate average quiz score for progress
            const quizzesWithScores = folderQuizzes.filter(q => q.best_score !== undefined && q.best_score !== null);
            const avgScore = quizzesWithScores.length > 0 
              ? Math.round(quizzesWithScores.reduce((acc, q) => acc + (q.best_score || 0), 0) / quizzesWithScores.length)
              : null;
            
            // Calculate flashcard mastery progress
            const totalCards = folderFlashcards.reduce((acc, f) => acc + f.total_cards, 0);
            const masteredCards = folderFlashcards.reduce((acc, f) => acc + f.mastery_count, 0);
            const masteryPercent = totalCards > 0 ? Math.round((masteredCards / totalCards) * 100) : null;

            return (
              <div
                key={folder.id}
                className="group flex items-center gap-6 border border-slate-800 p-5 h-[106px] transition hover:border-slate-600 cursor-pointer"
                onClick={() => handleEnterFolder(folder.id)}
              >
                {/* Left: Folder icon */}
                <div className="flex-shrink-0">
                  <div 
                    className="w-14 h-14 flex items-center justify-center border"
                    style={{ borderColor: getFolderColor(folder.color) }}
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8" fill={getFolderColor(folder.color)} viewBox="0 0 24 24">
                      <path d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z" />
                    </svg>
                  </div>
                </div>

                {/* Middle: Name and description */}
                <div className="flex-1 min-w-0">
                  <h3 className="text-lg font-semibold text-white">{folder.name}</h3>
                  {folder.description && (
                    <p className="text-slate-400 text-sm mt-0.5 line-clamp-1">{folder.description}</p>
                  )}
                </div>

                {/* Right: Stats */}
                <div className="flex items-center gap-6 flex-shrink-0">
                  {/* Practice sets count */}
                  <div className="text-center min-w-[100px]">
                    <div className="flex items-center justify-center gap-1.5">
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                      </svg>
                      <span className="text-white font-semibold">{setCount}</span>
                    </div>
                    <p className="text-slate-500 text-xs mt-0.5">Practice Sets</p>
                  </div>

                  {/* Progress */}
                  <div className="min-w-[120px]">
                    {(avgScore !== null || masteryPercent !== null) ? (
                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-slate-400 text-xs">Progress</span>
                          <span className="text-white text-sm font-medium">
                            {avgScore !== null ? `${avgScore}%` : masteryPercent !== null ? `${masteryPercent}%` : '—'}
                          </span>
                        </div>
                        <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
                          <div 
                            className="h-full bg-gradient-to-r from-indigo-500 to-purple-500 transition-all"
                            style={{ width: `${avgScore ?? masteryPercent ?? 0}%` }}
                          />
                        </div>
                      </div>
                    ) : (
                      <div className="text-center">
                        <span className="text-slate-500 text-sm">No progress yet</span>
                      </div>
                    )}
                  </div>

                  {/* Delete button */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeletePracticeFolder(folder.id);
                    }}
                    className="opacity-0 group-hover:opacity-100 text-slate-500 hover:text-red-400 transition cursor-pointer p-2"
                    title="Delete folder"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
              </div>
            );
          })}

          {/* Add Folder - Full Width */}
          {!showCreateFolderModal ? (
            <button
              onClick={() => setShowCreateFolderModal(true)}
              className="w-full flex items-center justify-center gap-3 border border-dashed border-slate-700 p-5 h-[106px] text-slate-500 hover:text-slate-300 hover:border-slate-500 transition cursor-pointer"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
              </svg>
              <span className="font-semibold">Add Practice Folder</span>
            </button>
          ) : (
            <div className="border border-slate-800 p-5 h-[106px]">
              <div className="flex items-center gap-6">
                {/* Left: Folder icon placeholder */}
                <div className="flex-shrink-0">
                  <div 
                    className="w-14 h-14 flex items-center justify-center border"
                    style={{ borderColor: newFolderColor }}
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8" fill={newFolderColor} viewBox="0 0 24 24">
                      <path d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z" />
                    </svg>
                  </div>
                </div>

                {/* Right: Form fields */}
                <div className="flex-1">
                  <div className="flex items-center gap-4">
                    {/* Color Picker */}
                    <div className="flex-shrink-0">
                      <label className="relative cursor-pointer group">
                        <input
                          type="color"
                          value={newFolderColor}
                          onChange={(e) => setNewFolderColor(e.target.value)}
                          className="sr-only"
                        />
                        <div 
                          className="w-10 h-10 rounded-full border-2 border-slate-600 group-hover:border-white group-hover:scale-110 transition cursor-pointer"
                          style={{ 
                            background: 'conic-gradient(from 0deg, #ff0000, #ff8000, #ffff00, #80ff00, #00ff00, #00ff80, #00ffff, #0080ff, #0000ff, #8000ff, #ff00ff, #ff0080, #ff0000)'
                          }}
                        />
                      </label>
                    </div>

                    {/* Folder Name */}
                    <div className="flex-1">
                      <input
                        type="text"
                        value={newFolderName}
                        onChange={(e) => setNewFolderName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && newFolderName.trim()) {
                            handleCreateFolder();
                          } else if (e.key === "Escape") {
                            setShowCreateFolderModal(false);
                            setNewFolderName("");
                            setNewFolderDescription("");
                            setNewFolderColor("#6366f1");
                          }
                        }}
                        placeholder="Folder name..."
                        className="w-full bg-slate-800 border border-slate-700 px-3 py-2.5 text-sm text-white placeholder-slate-500 focus:border-white focus:outline-none focus:ring-1 focus:ring-white"
                        autoFocus
                      />
                    </div>

                    {/* Description */}
                    <div className="flex-1">
                      <input
                        type="text"
                        value={newFolderDescription}
                        onChange={(e) => setNewFolderDescription(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && newFolderName.trim()) {
                            handleCreateFolder();
                          } else if (e.key === "Escape") {
                            setShowCreateFolderModal(false);
                            setNewFolderName("");
                            setNewFolderDescription("");
                            setNewFolderColor("#6366f1");
                          }
                        }}
                        placeholder="Description (optional)..."
                        className="w-full bg-slate-800 border border-slate-700 px-3 py-2.5 text-sm text-white placeholder-slate-500 focus:border-white focus:outline-none focus:ring-1 focus:ring-white"
                      />
                    </div>

                    {/* Action Buttons */}
                    <div className="flex gap-2">
                      <button
                        onClick={handleCreateFolder}
                        disabled={!newFolderName.trim()}
                        className="bg-white border border-white px-5 py-2.5 text-sm font-semibold text-black transition hover:bg-black hover:text-white disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                      >
                        Create
                      </button>
                      <button
                        onClick={() => {
                          setShowCreateFolderModal(false);
                          setNewFolderName("");
                          setNewFolderDescription("");
                          setNewFolderColor("#6366f1");
                        }}
                        className="border border-slate-600 px-5 py-2.5 text-sm font-semibold text-slate-400 transition hover:border-white hover:text-white cursor-pointer"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Uncategorized Practice Sets (not in any folder) */}
      {(() => {
        const unfolderedQuizzes = practiceOverview?.quizzes.filter(q => !q.folder_id) || [];
        const unfolderedFlashcards = practiceOverview?.flashcardSets.filter(f => !f.folder_id) || [];
        
        if (unfolderedQuizzes.length === 0 && unfolderedFlashcards.length === 0) {
          return null;
        }

        return (
          <div className="mb-8">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-white">Uncategorized Practice Sets</h2>
              <span className="text-slate-500 text-sm">
                {unfolderedQuizzes.length + unfolderedFlashcards.length} set{unfolderedQuizzes.length + unfolderedFlashcards.length !== 1 ? 's' : ''}
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {/* Quizzes */}
              {unfolderedQuizzes.map(quiz => (
                <div
                  key={quiz.id}
                  className="group border border-slate-800 p-4 transition hover:border-slate-600 cursor-pointer"
                  onClick={() => loadQuiz(quiz.id, quiz.question_type || 'multiple_choice')}
                >
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded flex items-center justify-center bg-slate-800">
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                        </svg>
                      </div>
                      <span className="text-xs font-medium uppercase text-slate-400">
                        {quiz.question_type === 'true_false' ? 'True/False' : 'Multiple Choice'}
                      </span>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteQuiz(quiz.id);
                      }}
                      className="opacity-0 group-hover:opacity-100 text-slate-500 hover:text-slate-300 transition p-1"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </div>
                  <h3 className="text-white font-medium mb-1 line-clamp-1">{quiz.name}</h3>
                  <p className="text-slate-500 text-sm mb-3">
                    {quiz.total_questions} question{quiz.total_questions !== 1 ? 's' : ''}
                  </p>
                  {quiz.best_score !== undefined && quiz.best_score !== null && (
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                        <div 
                          className="h-full bg-white transition-all"
                          style={{ width: `${quiz.best_score}%` }}
                        />
                      </div>
                      <span className="text-slate-400 text-xs">{quiz.best_score}%</span>
                    </div>
                  )}
                </div>
              ))}

              {/* Flashcard Sets */}
              {unfolderedFlashcards.map(set => (
                <div
                  key={set.id}
                  className="group border border-slate-800 p-4 transition hover:border-slate-600 cursor-pointer"
                  onClick={() => loadFlashcardSet(set.id)}
                >
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 bg-slate-800 rounded flex items-center justify-center">
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                        </svg>
                      </div>
                      <span className="text-xs text-slate-400 font-medium uppercase">Flashcards</span>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteFlashcardSet(set.id);
                      }}
                      className="opacity-0 group-hover:opacity-100 text-slate-500 hover:text-slate-300 transition p-1"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </div>
                  <h3 className="text-white font-medium mb-1 line-clamp-1">{set.name}</h3>
                  <p className="text-slate-500 text-sm mb-3">
                    {set.total_cards} card{set.total_cards !== 1 ? 's' : ''}
                  </p>
                  {set.mastery_count > 0 && (
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                        <div 
                          className="h-full bg-white transition-all"
                          style={{ width: `${Math.round((set.mastery_count / set.total_cards) * 100)}%` }}
                        />
                      </div>
                      <span className="text-slate-400 text-xs">{set.mastery_count}/{set.total_cards}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })()}


    </div>
  );
}
