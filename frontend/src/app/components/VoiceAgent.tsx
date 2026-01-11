"use client";

import { useState, useRef, useEffect, useCallback, useImperativeHandle, forwardRef } from 'react';

interface QuestionResult {
  questionNumber: number;
  questionText: string;
  userAnswer: string;
  correctAnswer: string;
  isCorrect: boolean;
  isAnswered: boolean;
  explanation?: string | null;
}

// Voice action types that can be triggered by voice commands
export type VoiceAction =
  | { type: 'GENERATE_QUIZ'; params: { questionCount?: number; sectionIds?: string[]; folderId?: string; materialName?: string; folderName?: string } }
  | { type: 'ANSWER_QUESTION'; params: { answer: string } }
  | { type: 'NEXT_QUESTION' }
  | { type: 'PREV_QUESTION' }
  | { type: 'SUBMIT_QUIZ' }
  | { type: 'FLIP_CARD' }
  | { type: 'NEXT_CARD' }
  | { type: 'PREV_CARD' }
  | { type: 'EXIT_PRACTICE' }
  | { type: 'GO_TO_QUESTION'; params: { questionNumber: number } }
  | { type: 'REPEAT_QUESTION' }
  | { type: 'REPEAT_ANSWERS' }
  | { type: 'SKIP_QUESTION' }
  | { type: 'READ_CURRENT_QUESTION' }
  | { type: 'REPEAT_CARD' };

// Expose speakText method to parent via ref
export interface VoiceAgentRef {
  speakText: (text: string) => Promise<void>;
  stopSpeaking: () => void;
}

interface VoiceAgentProps {
  context: {
    viewMode: string;
    currentQuestion?: any;
    currentQuestionIndex?: number;
    totalQuestions?: number;
    userAnswer?: string;
    showResults?: boolean;
    score?: { correct: number; total: number; percentage: number };
    quizName?: string;
    questionResults?: QuestionResult[];
    incorrectQuestions?: Array<{
      questionNumber: number;
      questionText: string;
      userAnswer: string;
      correctAnswer: string;
      explanation?: string | null;
    }>;
    correctQuestions?: number[];
    currentCard?: any;
    currentCardIndex?: number;
    totalCards?: number;
    isFlipped?: boolean;
    stats?: any;
  };
  userId?: string;
  isOpen: boolean;
  onClose: () => void;
  onAction?: (action: VoiceAction) => void;
}

interface Caption {
  id: string;
  text: string;
  timestamp: number;
  type: 'user' | 'assistant' | 'system';
}

const VoiceAgent = forwardRef<VoiceAgentRef, VoiceAgentProps>(function VoiceAgent({ context, userId, isOpen, onClose, onAction }, ref) {
  const [isConnected, setIsConnected] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [currentTranscript, setCurrentTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [audioLevel, setAudioLevel] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioQueueRef = useRef<ArrayBuffer[]>([]);
  const isPlayingRef = useRef(false);
  const captionsEndRef = useRef<HTMLDivElement>(null);
  const accumulatedTranscriptRef = useRef<string>('');
  
  // For interruption support (barge-in)
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const ttsAbortControllerRef = useRef<AbortController | null>(null);
  const chatAbortControllerRef = useRef<AbortController | null>(null);
  const isProcessingRef = useRef(false);
  const isSpeakingRef = useRef(false);

  // Auto-scroll captions
  useEffect(() => {
    captionsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [captions]);

  // Cleanup on unmount or close
  useEffect(() => {
    if (!isOpen) {
      cleanup();
    }
    return cleanup;
  }, [isOpen]);

  // Stop any ongoing speech/processing (for interruption support)
  const stopCurrentPlayback = useCallback(() => {
    // Stop current audio playback
    if (currentAudioRef.current) {
      currentAudioRef.current.pause();
      currentAudioRef.current.currentTime = 0;
      if (currentAudioRef.current.src) {
        URL.revokeObjectURL(currentAudioRef.current.src);
      }
      currentAudioRef.current = null;
    }
    
    // Abort ongoing TTS request
    if (ttsAbortControllerRef.current) {
      ttsAbortControllerRef.current.abort();
      ttsAbortControllerRef.current = null;
    }
    
    // Abort ongoing chat request
    if (chatAbortControllerRef.current) {
      chatAbortControllerRef.current.abort();
      chatAbortControllerRef.current = null;
    }
    
    isProcessingRef.current = false;
    isSpeakingRef.current = false;
    setIsSpeaking(false);
  }, []);

  const cleanup = () => {
    // Stop any playing audio first
    stopCurrentPlayback();
    
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (mediaRecorderRef.current) {
      try {
        mediaRecorderRef.current.stop();
      } catch (e) {
        // Ignore errors on cleanup
      }
      mediaRecorderRef.current = null;
    }
    if (audioContextRef.current) {
      try {
        audioContextRef.current.close();
      } catch (e) {
        // Ignore errors on cleanup
      }
      audioContextRef.current = null;
    }
    accumulatedTranscriptRef.current = '';
    setCurrentTranscript('');
    setIsConnected(false);
    setIsListening(false);
    setIsSpeaking(false);
  };

  // Add caption helper
  const addCaption = useCallback((text: string, type: Caption['type']) => {
    const caption: Caption = {
      id: `${Date.now()}-${Math.random()}`,
      text,
      timestamp: Date.now(),
      type,
    };
    setCaptions(prev => [...prev, caption]);
  }, []);

  // Get Deepgram token
  const getDeepgramToken = async (): Promise<string> => {
    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/voice/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      
      if (!response.ok) {
        throw new Error('Failed to get Deepgram token');
      }
      
      const data = await response.json();
      return data.access_token;
    } catch (err) {
      console.error('Token error:', err);
      throw new Error('Failed to authenticate with voice service');
    }
  };

  // Connect to Deepgram WebSocket
  const connectDeepgram = async () => {
    try {
      setError(null);
      addCaption('Connecting to voice service...', 'system');

      const token = await getDeepgramToken();
      
      // Connect to Deepgram v1/listen with browser-compatible settings
      // Using nova-2 model with interim results and utterance detection
      const wsUrl = `wss://api.deepgram.com/v1/listen?model=nova-2&language=en&punctuate=true&interim_results=true&utterance_end_ms=1000&vad_events=true`;
      
      const ws = new WebSocket(wsUrl, ['token', token]);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('Deepgram WebSocket connected');
        setIsConnected(true);
        addCaption('Connected! Start speaking...', 'system');
        startRecording();
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          
          // Handle v1/listen response format
          if (data.type === 'Results') {
            handleTranscriptResult(data);
          } else if (data.type === 'UtteranceEnd') {
            // User finished speaking - process the accumulated transcript
            handleUtteranceEnd();
          } else if (data.type === 'SpeechStarted') {
            // User started speaking - just set listening state
            // Don't interrupt here - wait for actual meaningful transcript to confirm it's real speech
            setIsListening(true);
          } else if (data.type === 'Error') {
            console.error('Deepgram error:', data);
            setError(data.description || data.message || 'Voice service error');
          }
        } catch (err) {
          console.error('Error parsing message:', err);
        }
      };

      ws.onerror = (err) => {
        console.error('WebSocket error:', err);
        setError('Connection error. Please try again.');
        setIsConnected(false);
      };

      ws.onclose = (event) => {
        console.log('Deepgram WebSocket closed:', event.code, event.reason);
        setIsConnected(false);
        setIsListening(false);
      };

    } catch (err) {
      console.error('Connection error:', err);
      setError(err instanceof Error ? err.message : 'Failed to connect');
    }
  };

  // Common filler sounds that shouldn't trigger interruption
  const FILLER_SOUNDS = new Set([
    'uh', 'um', 'uhm', 'uh-huh', 'uhuh', 'uh huh', 'uhhuh',
    'hmm', 'hm', 'hmmmm', 'hmmm', 'mm', 'mmm', 'mhm', 'mm-hmm', 'mmhmm',
    'ah', 'ahh', 'ahhh', 'oh', 'ohh', 'ohhh',
    'eh', 'er', 'err', 'erm',
    'like', 'so', 'well', 'yeah', 'yep', 'yup', 'nope', 'nah',
    'okay', 'ok', 'right', 'sure', 'uh-huh', 'mhmm',
    'huh', 'what', 'hmm?', 'hm?',
  ]);

  // Check if transcript is meaningful speech (not just noise or filler)
  const isMeaningfulSpeech = (transcript: string, confidence?: number): boolean => {
    if (!transcript || !transcript.trim()) return false;
    
    const trimmed = transcript.trim().toLowerCase();
    
    // Must have at least 2 characters
    if (trimmed.length < 2) return false;
    
    // Check if it's just a filler sound
    if (FILLER_SOUNDS.has(trimmed)) return false;
    
    // Also check without punctuation
    const noPunctuation = trimmed.replace(/[?!.,]/g, '').trim();
    if (FILLER_SOUNDS.has(noPunctuation)) return false;
    
    // Must have at least one word with 2+ characters that's not a filler
    const words = trimmed.split(/\s+/).filter(w => w.length >= 2);
    const meaningfulWords = words.filter(w => !FILLER_SOUNDS.has(w.replace(/[?!.,]/g, '')));
    if (meaningfulWords.length === 0) return false;
    
    // If confidence is available, require minimum threshold
    if (confidence !== undefined && confidence < 0.7) return false;
    
    return true;
  };

  // Handle transcript results from Deepgram v1/listen
  const handleTranscriptResult = (data: any) => {
    const transcript = data.channel?.alternatives?.[0]?.transcript;
    const confidence = data.channel?.alternatives?.[0]?.confidence;
    const isFinal = data.is_final;
    const speechFinal = data.speech_final;

    if (transcript) {
      // If AI is ACTUALLY speaking audio and we get meaningful transcript, user is interrupting (barge-in)
      // Only interrupt if audio is playing and the speech is meaningful (not background noise)
      if (isSpeakingRef.current && isFinal && isMeaningfulSpeech(transcript, confidence)) {
        console.log('User interrupted with speech - stopping AI (barge-in)');
        stopCurrentPlayback();
        addCaption('(Interrupted)', 'system');
      }
      
      if (isFinal) {
        // Final transcript for this segment - accumulate it
        accumulatedTranscriptRef.current += (accumulatedTranscriptRef.current ? ' ' : '') + transcript;
        setCurrentTranscript(accumulatedTranscriptRef.current);
        setIsListening(true);
        
        // If speech_final is true, the speaker has paused - process the utterance
        if (speechFinal && accumulatedTranscriptRef.current.trim()) {
          const fullTranscript = accumulatedTranscriptRef.current.trim();
          accumulatedTranscriptRef.current = '';
          setCurrentTranscript('');
          setIsListening(false);
          processUserSpeech(fullTranscript);
        }
      } else {
        // Interim result - show it but don't save
        const interimDisplay = accumulatedTranscriptRef.current 
          ? accumulatedTranscriptRef.current + ' ' + transcript 
          : transcript;
        setCurrentTranscript(interimDisplay);
        setIsListening(true);
      }
    }
  };

  // Handle utterance end event
  const handleUtteranceEnd = () => {
    if (accumulatedTranscriptRef.current.trim()) {
      const fullTranscript = accumulatedTranscriptRef.current.trim();
      accumulatedTranscriptRef.current = '';
      setCurrentTranscript('');
      setIsListening(false);
      processUserSpeech(fullTranscript);
    }
  };

  // Map action string to VoiceAction type
  const mapActionToVoiceAction = (action: string, params: any): VoiceAction | null => {
    switch (action) {
      case 'GENERATE_QUIZ':
        return {
          type: 'GENERATE_QUIZ',
          params: {
            questionCount: params?.questionCount || 20,
            sectionIds: params?.sectionIds || null,
            folderId: params?.folderId || null,
            materialName: params?.materialName || null,
            folderName: params?.folderName || null,
          }
        };
      case 'ANSWER_QUESTION':
        if (params?.answer) {
          return { type: 'ANSWER_QUESTION', params: { answer: params.answer } };
        }
        return null;
      case 'NEXT_QUESTION':
        return { type: 'NEXT_QUESTION' };
      case 'PREV_QUESTION':
        return { type: 'PREV_QUESTION' };
      case 'SUBMIT_QUIZ':
        return { type: 'SUBMIT_QUIZ' };
      case 'FLIP_CARD':
        return { type: 'FLIP_CARD' };
      case 'NEXT_CARD':
        return { type: 'NEXT_CARD' };
      case 'PREV_CARD':
        return { type: 'PREV_CARD' };
      case 'EXIT_PRACTICE':
        return { type: 'EXIT_PRACTICE' };
      case 'REPEAT_QUESTION':
        return { type: 'REPEAT_QUESTION' };
      case 'REPEAT_ANSWERS':
        return { type: 'REPEAT_ANSWERS' };
      case 'SKIP_QUESTION':
        return { type: 'SKIP_QUESTION' };
      case 'READ_CURRENT_QUESTION':
        return { type: 'READ_CURRENT_QUESTION' };
      case 'REPEAT_CARD':
        return { type: 'REPEAT_CARD' };
      default:
        return null;
    }
  };

  // Process user speech and get AI response
  const processUserSpeech = async (transcript: string) => {
    // Cancel any previous processing
    if (chatAbortControllerRef.current) {
      chatAbortControllerRef.current.abort();
    }
    
    // Create new abort controller for this request
    const abortController = new AbortController();
    chatAbortControllerRef.current = abortController;
    isProcessingRef.current = true;
    
    try {
      addCaption(transcript, 'user');

      // Stream response from backend - include userId for material lookup
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/voice/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript, context, userId }),
        signal: abortController.signal,
      });

      if (!response.ok) {
        throw new Error('Failed to get response');
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let fullText = '';
      let actionExecuted = false;

      if (reader) {
        try {
          while (true) {
            // Check if aborted
            if (abortController.signal.aborted) {
              reader.cancel();
              break;
            }
            
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value);
            const lines = chunk.split('\n');

            for (const line of lines) {
              if (line.startsWith('data: ')) {
                try {
                  const data = JSON.parse(line.slice(6));
                  
                  // Handle action commands from backend
                  if (data.action && onAction && !actionExecuted) {
                    const voiceAction = mapActionToVoiceAction(data.action, data.params);
                    if (voiceAction) {
                      console.log('Executing voice action:', voiceAction);
                      addCaption(`[Action: ${data.action}]`, 'system');
                      onAction(voiceAction);
                      actionExecuted = true;
                    }
                  }
                  
                  if (data.text) {
                    fullText += data.text;
                  }
                  if (data.done && !abortController.signal.aborted) {
                    // Add caption first, then speak (only if not interrupted)
                    addCaption(fullText, 'assistant');
                    await speakText(fullText);
                  }
                  if (data.error) {
                    throw new Error(data.error);
                  }
                } catch (e) {
                  // Ignore parse errors for empty lines
                }
              }
            }
          }
        } finally {
          reader.releaseLock();
        }
      }
    } catch (err) {
      // Don't show error if aborted (user interrupted)
      if (err instanceof Error && err.name === 'AbortError') {
        console.log('Chat request aborted (user interrupted)');
        return;
      }
      console.error('Process speech error:', err);
      setError('Failed to process your message');
    } finally {
      isProcessingRef.current = false;
    }
  };

  // Convert text to speech using Deepgram TTS
  const speakText = async (text: string): Promise<void> => {
    // Cancel any previous TTS request
    if (ttsAbortControllerRef.current) {
      ttsAbortControllerRef.current.abort();
    }
    
    // Create new abort controller for this request
    const abortController = new AbortController();
    ttsAbortControllerRef.current = abortController;
    
    return new Promise(async (resolve, reject) => {
      try {
        setIsSpeaking(true);
        isSpeakingRef.current = true;
        
        const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/voice/tts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
          signal: abortController.signal,
        });

        if (!response.ok) {
          throw new Error('Failed to generate speech');
        }

        // Check if aborted before playing
        if (abortController.signal.aborted) {
          setIsSpeaking(false);
          isSpeakingRef.current = false;
          resolve();
          return;
        }

        const audioBlob = await response.blob();
        const audioUrl = URL.createObjectURL(audioBlob);
        const audio = new Audio(audioUrl);
        
        // Store reference to current audio for interruption
        currentAudioRef.current = audio;

        audio.onended = () => {
          setIsSpeaking(false);
          isSpeakingRef.current = false;
          URL.revokeObjectURL(audioUrl);
          currentAudioRef.current = null;
          resolve();
        };

        audio.onerror = (e) => {
          setIsSpeaking(false);
          isSpeakingRef.current = false;
          URL.revokeObjectURL(audioUrl);
          currentAudioRef.current = null;
          reject(e);
        };

        // Check one more time before playing
        if (abortController.signal.aborted) {
          setIsSpeaking(false);
          isSpeakingRef.current = false;
          URL.revokeObjectURL(audioUrl);
          resolve();
          return;
        }

        await audio.play();
      } catch (err) {
        // Don't log error if aborted (user interrupted)
        if (err instanceof Error && err.name === 'AbortError') {
          console.log('TTS request aborted (user interrupted)');
          setIsSpeaking(false);
          isSpeakingRef.current = false;
          resolve();
          return;
        }
        console.error('Speech synthesis error:', err);
        setIsSpeaking(false);
        isSpeakingRef.current = false;
        reject(err);
      }
    });
  };

  // Expose methods to parent via ref
  useImperativeHandle(ref, () => ({
    speakText: async (text: string) => {
      addCaption(text, 'assistant');
      await speakText(text);
    },
    stopSpeaking: () => {
      stopCurrentPlayback();
    }
  }), [addCaption, stopCurrentPlayback]);

  // Start recording audio
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
        } 
      });

      // Set up audio level monitoring
      const audioContext = new AudioContext({ sampleRate: 16000 });
      audioContextRef.current = audioContext;
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyserRef.current = analyser;

      // Monitor audio levels for visual feedback
      const updateAudioLevel = () => {
        if (analyserRef.current) {
          const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
          analyserRef.current.getByteFrequencyData(dataArray);
          const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
          setAudioLevel(average / 255);
        }
        if (isConnected) {
          requestAnimationFrame(updateAudioLevel);
        }
      };
      updateAudioLevel();

      // Set up MediaRecorder to send audio to Deepgram
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: 'audio/webm',
      });
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0 && wsRef.current?.readyState === WebSocket.OPEN) {
          // Convert to the format Deepgram expects
          event.data.arrayBuffer().then(buffer => {
            wsRef.current?.send(buffer);
          });
        }
      };

      mediaRecorder.start(250); // Send chunks every 250ms
    } catch (err) {
      console.error('Recording error:', err);
      setError('Failed to access microphone');
    }
  };

  // Handle start/stop
  const toggleConnection = () => {
    if (isConnected) {
      cleanup();
    } else {
      connectDeepgram();
    }
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyPress = (e: KeyboardEvent) => {
      if (!isOpen) return;
      
      // Space to toggle connection
      if (e.code === 'Space' && e.target === document.body) {
        e.preventDefault();
        toggleConnection();
      }
      // Escape to close
      if (e.code === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyPress);
    return () => document.removeEventListener('keydown', handleKeyPress);
  }, [isOpen, isConnected, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-y-0 right-0 z-50 w-[400px] bg-slate-900 border-l border-slate-700 shadow-2xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700 bg-slate-800">
          <div className="flex items-center gap-3">
            <div className={`w-3 h-3 rounded-full transition-colors ${
              isConnected ? 'bg-green-500 animate-pulse' : 'bg-slate-600'
            }`} />
            <h2 className="text-lg font-semibold text-white">Voice Study Assistant</h2>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white transition"
            aria-label="Close voice assistant"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Captions/Transcript Area */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4 min-h-[300px]">
          {captions.map((caption) => (
            <div
              key={caption.id}
              className={`flex ${
                caption.type === 'user' 
                  ? 'justify-end' 
                  : caption.type === 'system' 
                    ? 'justify-center' 
                    : 'justify-start'
              }`}
            >
              <div
                className={`max-w-[80%] px-4 py-3 rounded-lg ${
                  caption.type === 'user'
                    ? 'bg-indigo-600 text-white'
                    : caption.type === 'assistant'
                    ? 'bg-slate-700 text-white'
                    : 'bg-amber-900/40 text-amber-300 text-sm italic border border-amber-500/30'
                }`}
              >
                <p className="break-words">{caption.text}</p>
              </div>
            </div>
          ))}
          
          {/* Live transcript preview */}
          {currentTranscript && (
            <div className="flex justify-end">
              <div className="max-w-[80%] px-4 py-3 rounded-lg bg-indigo-500/50 text-white border border-indigo-400">
                <p className="break-words">{currentTranscript}</p>
                <span className="text-xs text-indigo-200 italic">Speaking...</span>
              </div>
            </div>
          )}

          {/* Speaking indicator with interruption hint */}
          {isSpeaking && (
            <div className="flex justify-start">
              <div className="bg-slate-700 px-4 py-3 rounded-lg">
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <div className="flex gap-1">
                      <div className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                      <div className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                      <div className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                    </div>
                    <span className="text-slate-300 text-sm">Assistant is speaking...</span>
                  </div>
                  <span className="text-xs text-slate-500 italic">Speak anytime to interrupt</span>
                </div>
              </div>
            </div>
          )}

          <div ref={captionsEndRef} />
        </div>

        {/* Error Display */}
        {error && (
          <div className="px-6 py-3 bg-red-900/30 border-t border-red-500/50">
            <p className="text-red-300 text-sm">{error}</p>
          </div>
        )}

        {/* Controls */}
        <div className="px-6 py-6 border-t border-slate-700 bg-slate-800">
          <div className="flex flex-col items-center gap-4">
            {/* Audio level indicator */}
            {isConnected && (
              <div className="w-full">
                <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-indigo-500 to-purple-500 transition-all duration-100"
                    style={{ width: `${audioLevel * 100}%` }}
                  />
                </div>
              </div>
            )}

            {/* Main button */}
            <button
              onClick={toggleConnection}
              className={`relative w-20 h-20 rounded-full flex items-center justify-center transition-all transform hover:scale-105 ${
                isConnected
                  ? isListening
                    ? 'bg-red-500 hover:bg-red-600 shadow-lg shadow-red-500/50 animate-pulse'
                    : isSpeaking
                      ? 'bg-purple-600 hover:bg-purple-700 shadow-lg shadow-purple-500/50'
                      : 'bg-indigo-600 hover:bg-indigo-700 shadow-lg shadow-indigo-500/50'
                  : 'bg-white hover:bg-slate-200'
              }`}
              aria-label={isConnected ? 'Stop voice assistant' : 'Start voice assistant'}
            >
              {isConnected ? (
                <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8 text-white" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
                  <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
                </svg>
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8 text-black" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                </svg>
              )}
            </button>

            {/* Status text */}
            <div className="text-center">
              <p className="text-white font-medium">
                {isConnected 
                  ? isListening 
                    ? 'Listening...' 
                    : isSpeaking 
                      ? 'Speaking...' 
                      : 'Ready to listen'
                  : 'Click to start'}
              </p>
              <p className="text-slate-400 text-sm mt-1">
                Press <kbd className="px-2 py-0.5 bg-slate-700 rounded text-xs">Space</kbd> to toggle • <kbd className="px-2 py-0.5 bg-slate-700 rounded text-xs">Esc</kbd> to close
              </p>
            </div>

            {/* Context indicator */}
            <div className="w-full px-4 py-2 bg-slate-700/50 rounded text-center">
              <p className="text-slate-300 text-sm">
                Context: <span className="font-medium text-white">
                  {context.viewMode === 'quiz' && context.showResults 
                    ? `Quiz Results - ${context.score?.correct}/${context.score?.total} (${context.score?.percentage}%)`
                    : context.viewMode === 'quiz'
                    ? `Quiz Question ${context.currentQuestionIndex! + 1}/${context.totalQuestions}`
                    : context.viewMode === 'flashcards'
                    ? `Flashcard ${context.currentCardIndex! + 1}/${context.totalCards}`
                    : 'Practice Overview'}
                </span>
              </p>
              {context.viewMode === 'quiz' && context.showResults && context.incorrectQuestions && (
                <p className="text-slate-400 text-xs mt-1">
                  {context.incorrectQuestions.length === 0 
                    ? 'Perfect score! Ask me about the topics covered.'
                    : `${context.incorrectQuestions.length} question${context.incorrectQuestions.length > 1 ? 's' : ''} to review - ask me to explain!`}
                </p>
              )}
            </div>

            {/* Voice Commands Help */}
            <div className="w-full px-3 py-2 bg-indigo-900/30 rounded border border-indigo-500/30">
              <p className="text-indigo-300 text-xs font-medium mb-1">🎤 Voice Commands:</p>
              <div className="text-slate-400 text-xs space-y-0.5">
                {context.viewMode === 'overview' && (
                  <>
                    <p>• "Generate 50 questions on [material name]"</p>
                    <p>• "Create a quiz from [folder name]"</p>
                  </>
                )}
                {context.viewMode === 'quiz' && !context.showResults && (
                  <>
                    <p>• Say "A", "B", "C", or "D" to answer (auto-advances)</p>
                    <p>• "Repeat question" / "Read the answers"</p>
                    <p>• "Skip question" to skip current question</p>
                    <p>• "Submit quiz" to finish</p>
                    <p>• "Go back" to exit</p>
                  </>
                )}
                {context.viewMode === 'quiz' && context.showResults && (
                  <>
                    <p>• "Explain question 3" - get help on specific questions</p>
                    <p>• "Go back" to return to overview</p>
                  </>
                )}
                {context.viewMode === 'flashcards' && (
                  <>
                    <p>• "Flip card" / "Show answer"</p>
                    <p>• "Next card" / "Previous card"</p>
                    <p>• "Go back" to exit</p>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
    </div>
  );
});

export default VoiceAgent;
