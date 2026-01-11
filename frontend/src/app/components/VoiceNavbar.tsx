"use client";

import { useState, useRef, useEffect, useCallback, useImperativeHandle, forwardRef } from "react";

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
  | { type: 'REPEAT_CARD' }
  | { type: 'GET_HINT' }
  | { type: 'ENABLE_READ_ALOUD_MODE' }
  | { type: 'DISABLE_READ_ALOUD_MODE' };

export interface VoiceNavbarRef {
  speakText: (text: string) => Promise<void>;
  stopSpeaking: () => void;
}

interface VoiceNavbarProps {
  context: {
    viewMode: string;
    currentQuestion?: any;
    currentQuestionIndex?: number;
    totalQuestions?: number;
    userAnswer?: string;
    showResults?: boolean;
    score?: { correct: number; total: number; percentage: number };
    quizName?: string;
    currentCard?: any;
    currentCardIndex?: number;
    totalCards?: number;
    isFlipped?: boolean;
    sourceMaterialIds?: string[]; // Material IDs for RAG hint retrieval
  };
  userId?: string;
  onAction?: (action: VoiceAction) => void;
}

const VoiceNavbar = forwardRef<VoiceNavbarRef, VoiceNavbarProps>(function VoiceNavbar({ context, userId, onAction }, ref) {
  const [isConnected, setIsConnected] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [currentTranscript, setCurrentTranscript] = useState("");
  const [lastResponse, setLastResponse] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [audioLevels, setAudioLevels] = useState<number[]>(Array(24).fill(8));

  const wsRef = useRef<WebSocket | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const accumulatedTranscriptRef = useRef<string>("");
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const ttsAbortControllerRef = useRef<AbortController | null>(null);
  const chatAbortControllerRef = useRef<AbortController | null>(null);
  const isSpeakingRef = useRef(false);
  
  const idleAnimationRef = useRef<number | null>(null);
  const listeningAnimationRef = useRef<number | null>(null);
  const speakingAnimationRef = useRef<number | null>(null);

  // Trigger visibility animation on mount
  useEffect(() => {
    const timer = setTimeout(() => setIsVisible(true), 50);
    return () => clearTimeout(timer);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanup();
    };
  }, []);

  // Animation effects for audio levels
  useEffect(() => {
    if (isListening) {
      if (idleAnimationRef.current) cancelAnimationFrame(idleAnimationRef.current);
      if (speakingAnimationRef.current) cancelAnimationFrame(speakingAnimationRef.current);

      let startTime: number | null = null;
      const animateListening = (timestamp: number) => {
        if (!startTime) startTime = timestamp;
        const elapsed = timestamp - startTime;
        
        const newLevels = Array.from({ length: 24 }, (_, i) => {
          const centerIndex = 11.5;
          const distanceFromCenter = Math.abs(i - centerIndex);
          const wave1 = Math.sin((elapsed / 100) * 2 + i * 0.3) * 25;
          const wave2 = Math.sin((elapsed / 80) * 3 + i * 0.2) * 15;
          const wave3 = Math.sin((elapsed / 150) + distanceFromCenter * 0.5) * 10;
          const noise = Math.sin(elapsed / 50 + i * 1.7) * 8;
          const level = 30 + wave1 + wave2 + wave3 + noise;
          return Math.max(10, Math.min(95, level));
        });
        
        setAudioLevels(newLevels);
        listeningAnimationRef.current = requestAnimationFrame(animateListening);
      };
      
      listeningAnimationRef.current = requestAnimationFrame(animateListening);
      return () => { if (listeningAnimationRef.current) cancelAnimationFrame(listeningAnimationRef.current); };
    }
  }, [isListening]);

  useEffect(() => {
    if (isSpeaking && !isListening) {
      if (idleAnimationRef.current) cancelAnimationFrame(idleAnimationRef.current);
      if (listeningAnimationRef.current) cancelAnimationFrame(listeningAnimationRef.current);

      let startTime: number | null = null;
      const animateSpeaking = (timestamp: number) => {
        if (!startTime) startTime = timestamp;
        const elapsed = timestamp - startTime;
        
        const newLevels = Array.from({ length: 24 }, (_, i) => {
          const centerIndex = 11.5;
          const distanceFromCenter = Math.abs(i - centerIndex);
          const wave1 = Math.sin((elapsed / 200) * 1.5 + i * 0.2) * 20;
          const wave2 = Math.sin((elapsed / 300) * 2.5 + i * 0.15) * 12;
          const wave3 = Math.sin((elapsed / 400) + distanceFromCenter * 0.3) * 8;
          const level = 25 + wave1 + wave2 + wave3;
          return Math.max(12, Math.min(70, level));
        });
        
        setAudioLevels(newLevels);
        speakingAnimationRef.current = requestAnimationFrame(animateSpeaking);
      };
      
      speakingAnimationRef.current = requestAnimationFrame(animateSpeaking);
      return () => { if (speakingAnimationRef.current) cancelAnimationFrame(speakingAnimationRef.current); };
    }
  }, [isSpeaking, isListening]);

  useEffect(() => {
    if (isConnected && !isListening && !isSpeaking) {
      if (listeningAnimationRef.current) cancelAnimationFrame(listeningAnimationRef.current);
      if (speakingAnimationRef.current) cancelAnimationFrame(speakingAnimationRef.current);

      let startTime: number | null = null;
      const animateIdle = (timestamp: number) => {
        if (!startTime) startTime = timestamp;
        const elapsed = timestamp - startTime;
        
        const newLevels = Array.from({ length: 24 }, (_, i) => {
          const centerIndex = 11.5;
          const distanceFromCenter = Math.abs(i - centerIndex);
          const wave1 = Math.sin((elapsed / 1000) * 1.5 + i * 0.15) * 12;
          const wave2 = Math.sin((elapsed / 1000) * 2.3 + i * 0.1) * 8;
          const wave3 = Math.sin((elapsed / 1000) * 0.7 + distanceFromCenter * 0.2) * 6;
          const level = 15 + wave1 + wave2 + wave3;
          return Math.max(8, Math.min(40, level));
        });
        
        setAudioLevels(newLevels);
        idleAnimationRef.current = requestAnimationFrame(animateIdle);
      };
      
      idleAnimationRef.current = requestAnimationFrame(animateIdle);
      return () => { if (idleAnimationRef.current) cancelAnimationFrame(idleAnimationRef.current); };
    } else if (!isConnected) {
      if (idleAnimationRef.current) cancelAnimationFrame(idleAnimationRef.current);
      if (listeningAnimationRef.current) cancelAnimationFrame(listeningAnimationRef.current);
      if (speakingAnimationRef.current) cancelAnimationFrame(speakingAnimationRef.current);
      
      let startTime: number | null = null;
      const animateInactive = (timestamp: number) => {
        if (!startTime) startTime = timestamp;
        const elapsed = timestamp - startTime;
        
        const newLevels = Array.from({ length: 24 }, (_, i) => {
          const wave = Math.sin((elapsed / 2000) * 1 + i * 0.1) * 4;
          const level = 10 + wave;
          return Math.max(6, Math.min(18, level));
        });
        
        setAudioLevels(newLevels);
        idleAnimationRef.current = requestAnimationFrame(animateInactive);
      };
      
      idleAnimationRef.current = requestAnimationFrame(animateInactive);
      return () => { if (idleAnimationRef.current) cancelAnimationFrame(idleAnimationRef.current); };
    }
  }, [isConnected, isListening, isSpeaking]);

  const stopCurrentPlayback = useCallback(() => {
    if (currentAudioRef.current) {
      currentAudioRef.current.pause();
      currentAudioRef.current.currentTime = 0;
      if (currentAudioRef.current.src) URL.revokeObjectURL(currentAudioRef.current.src);
      currentAudioRef.current = null;
    }
    if (ttsAbortControllerRef.current) {
      ttsAbortControllerRef.current.abort();
      ttsAbortControllerRef.current = null;
    }
    if (chatAbortControllerRef.current) {
      chatAbortControllerRef.current.abort();
      chatAbortControllerRef.current = null;
    }
    isSpeakingRef.current = false;
    setIsSpeaking(false);
  }, []);

  const cleanup = useCallback(() => {
    stopCurrentPlayback();
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (mediaRecorderRef.current) {
      try { mediaRecorderRef.current.stop(); } catch {}
      mediaRecorderRef.current = null;
    }
    if (audioContextRef.current) {
      try { audioContextRef.current.close(); } catch {}
      audioContextRef.current = null;
    }
    accumulatedTranscriptRef.current = "";
    setCurrentTranscript("");
    setIsConnected(false);
    setIsListening(false);
    setIsSpeaking(false);
  }, [stopCurrentPlayback]);

  const getDeepgramToken = async (): Promise<string> => {
    const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/voice/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!response.ok) throw new Error('Failed to get Deepgram token');
    const data = await response.json();
    return data.access_token;
  };

  const FILLER_SOUNDS = new Set([
    'uh', 'um', 'uhm', 'uh-huh', 'hmm', 'hm', 'mm', 'mmm', 'mhm',
    'ah', 'ahh', 'oh', 'ohh', 'eh', 'er', 'err', 'like', 'so', 'well',
    'yeah', 'yep', 'yup', 'nope', 'okay', 'ok', 'right', 'sure', 'huh',
  ]);

  const isMeaningfulSpeech = (transcript: string, confidence?: number): boolean => {
    if (!transcript?.trim()) return false;
    const trimmed = transcript.trim().toLowerCase();
    if (trimmed.length < 2) return false;
    if (FILLER_SOUNDS.has(trimmed)) return false;
    const noPunctuation = trimmed.replace(/[?!.,]/g, '').trim();
    if (FILLER_SOUNDS.has(noPunctuation)) return false;
    const words = trimmed.split(/\s+/).filter(w => w.length >= 2);
    const meaningfulWords = words.filter(w => !FILLER_SOUNDS.has(w.replace(/[?!.,]/g, '')));
    if (meaningfulWords.length === 0) return false;
    if (confidence !== undefined && confidence < 0.7) return false;
    return true;
  };

  const mapActionToVoiceAction = (action: string, params: any): VoiceAction | null => {
    switch (action) {
      case 'GENERATE_QUIZ': return { type: 'GENERATE_QUIZ', params: { questionCount: params?.questionCount || 20, sectionIds: params?.sectionIds, folderId: params?.folderId, materialName: params?.materialName, folderName: params?.folderName } };
      case 'ANSWER_QUESTION': return params?.answer ? { type: 'ANSWER_QUESTION', params: { answer: params.answer } } : null;
      case 'NEXT_QUESTION': return { type: 'NEXT_QUESTION' };
      case 'PREV_QUESTION': return { type: 'PREV_QUESTION' };
      case 'SUBMIT_QUIZ': return { type: 'SUBMIT_QUIZ' };
      case 'FLIP_CARD': return { type: 'FLIP_CARD' };
      case 'NEXT_CARD': return { type: 'NEXT_CARD' };
      case 'PREV_CARD': return { type: 'PREV_CARD' };
      case 'EXIT_PRACTICE': return { type: 'EXIT_PRACTICE' };
      case 'REPEAT_QUESTION': return { type: 'REPEAT_QUESTION' };
      case 'REPEAT_ANSWERS': return { type: 'REPEAT_ANSWERS' };
      case 'SKIP_QUESTION': return { type: 'SKIP_QUESTION' };
      case 'READ_CURRENT_QUESTION': return { type: 'READ_CURRENT_QUESTION' };
      case 'REPEAT_CARD': return { type: 'REPEAT_CARD' };
      case 'ENABLE_READ_ALOUD_MODE': return { type: 'ENABLE_READ_ALOUD_MODE' };
      case 'DISABLE_READ_ALOUD_MODE': return { type: 'DISABLE_READ_ALOUD_MODE' };
      default: return null;
    }
  };

  const speakText = useCallback(async (text: string): Promise<void> => {
    if (currentAudioRef.current) {
      currentAudioRef.current.pause();
      if (currentAudioRef.current.src) URL.revokeObjectURL(currentAudioRef.current.src);
      currentAudioRef.current = null;
    }
    if (ttsAbortControllerRef.current) ttsAbortControllerRef.current.abort();

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

        if (!response.ok) throw new Error('Failed to generate speech');
        if (abortController.signal.aborted) { setIsSpeaking(false); isSpeakingRef.current = false; resolve(); return; }

        const audioBlob = await response.blob();
        if (abortController.signal.aborted) { setIsSpeaking(false); isSpeakingRef.current = false; resolve(); return; }

        const audioUrl = URL.createObjectURL(audioBlob);
        const audio = new Audio(audioUrl);
        currentAudioRef.current = audio;

        audio.onended = () => { setIsSpeaking(false); isSpeakingRef.current = false; URL.revokeObjectURL(audioUrl); currentAudioRef.current = null; resolve(); };
        audio.onerror = (e) => { setIsSpeaking(false); isSpeakingRef.current = false; URL.revokeObjectURL(audioUrl); currentAudioRef.current = null; reject(e); };
        if (abortController.signal.aborted) { setIsSpeaking(false); isSpeakingRef.current = false; URL.revokeObjectURL(audioUrl); resolve(); return; }
        await audio.play();
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') { setIsSpeaking(false); isSpeakingRef.current = false; resolve(); return; }
        setIsSpeaking(false);
        isSpeakingRef.current = false;
        reject(err);
      }
    });
  }, []);

  const processUserSpeech = useCallback(async (transcript: string) => {
    if (chatAbortControllerRef.current) chatAbortControllerRef.current.abort();
    const abortController = new AbortController();
    chatAbortControllerRef.current = abortController;
    
    try {
      setLastResponse("");
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/voice/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript, context, userId }),
        signal: abortController.signal,
      });

      if (!response.ok) throw new Error('Failed to get response');

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let fullText = '';
      let actionExecuted = false;

      if (reader) {
        try {
          while (true) {
            if (abortController.signal.aborted) { reader.cancel(); break; }
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value);
            const lines = chunk.split('\n');

            for (const line of lines) {
              if (line.startsWith('data: ')) {
                try {
                  const data = JSON.parse(line.slice(6));
                  if (data.action && onAction && !actionExecuted) {
                    const voiceAction = mapActionToVoiceAction(data.action, data.params);
                    if (voiceAction) { onAction(voiceAction); actionExecuted = true; }
                  }
                  if (data.text) fullText += data.text;
                  if (data.done && !abortController.signal.aborted) {
                    setLastResponse(fullText);
                    await speakText(fullText);
                  }
                } catch {}
              }
            }
          }
        } finally { reader.releaseLock(); }
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setError('Failed to process your message');
    }
  }, [context, userId, onAction, speakText]);

  const handleTranscriptResult = useCallback((data: any) => {
    const transcript = data.channel?.alternatives?.[0]?.transcript;
    const confidence = data.channel?.alternatives?.[0]?.confidence;
    const isFinal = data.is_final;
    const speechFinal = data.speech_final;

    if (transcript) {
      if (isSpeakingRef.current && isFinal && isMeaningfulSpeech(transcript, confidence)) {
        stopCurrentPlayback();
      }
      
      if (isFinal) {
        accumulatedTranscriptRef.current += (accumulatedTranscriptRef.current ? ' ' : '') + transcript;
        setCurrentTranscript(accumulatedTranscriptRef.current);
        setIsListening(true);
        
        if (speechFinal && accumulatedTranscriptRef.current.trim()) {
          const fullTranscript = accumulatedTranscriptRef.current.trim();
          accumulatedTranscriptRef.current = '';
          setCurrentTranscript('');
          setIsListening(false);
          processUserSpeech(fullTranscript);
        }
      } else {
        const interimDisplay = accumulatedTranscriptRef.current ? accumulatedTranscriptRef.current + ' ' + transcript : transcript;
        setCurrentTranscript(interimDisplay);
        setIsListening(true);
      }
    }
  }, [stopCurrentPlayback, processUserSpeech]);

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true } 
      });

      audioContextRef.current = new AudioContext({ sampleRate: 16000 });

      const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0 && wsRef.current?.readyState === WebSocket.OPEN) {
          event.data.arrayBuffer().then(buffer => wsRef.current?.send(buffer));
        }
      };

      mediaRecorder.start(250);
    } catch (err) {
      setError('Failed to access microphone');
    }
  }, []);

  // Generate a context-aware greeting from Cortana
  const getGreeting = useCallback(() => {
    if (context.viewMode === 'quiz' && !context.showResults) {
      return `Hi, I'm Cortana. How can I help you with this quiz? Would you like me to read through the questions with you, or do you need a hint?`;
    } else if (context.viewMode === 'quiz' && context.showResults) {
      return `Hi, I'm Cortana. I see you've finished the quiz. Would you like me to help explain any questions you missed?`;
    } else if (context.viewMode === 'flashcards') {
      return `Hi, I'm Cortana. Ready to study flashcards? Let me know if you'd like me to read them aloud or if you need any help.`;
    } else {
      return `Hi, I'm Cortana. How can I help you study today?`;
    }
  }, [context.viewMode, context.showResults]);

  const connectDeepgram = useCallback(async () => {
    try {
      setError(null);
      const token = await getDeepgramToken();
      
      const wsUrl = `wss://api.deepgram.com/v1/listen?model=nova-2&language=en&punctuate=true&interim_results=true&utterance_end_ms=1000&vad_events=true`;
      const ws = new WebSocket(wsUrl, ['token', token]);
      wsRef.current = ws;

      ws.onopen = async () => {
        setIsConnected(true);
        startRecording();
        // Cortana greets the user on connection
        const greeting = getGreeting();
        setLastResponse(greeting);
        await speakText(greeting);
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'Results') handleTranscriptResult(data);
          else if (data.type === 'UtteranceEnd' && accumulatedTranscriptRef.current.trim()) {
            const fullTranscript = accumulatedTranscriptRef.current.trim();
            accumulatedTranscriptRef.current = '';
            setCurrentTranscript('');
            setIsListening(false);
            processUserSpeech(fullTranscript);
          }
          else if (data.type === 'SpeechStarted') setIsListening(true);
          else if (data.type === 'Error') setError(data.description || 'Voice service error');
        } catch {}
      };

      ws.onerror = () => { setError('Connection error'); setIsConnected(false); };
      ws.onclose = () => { setIsConnected(false); setIsListening(false); };
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect');
    }
  }, [startRecording, handleTranscriptResult, processUserSpeech, speakText, getGreeting]);

  const toggleConnection = useCallback(() => {
    if (isConnected) {
      cleanup();
    } else {
      connectDeepgram();
    }
  }, [isConnected, cleanup, connectDeepgram]);

  useImperativeHandle(ref, () => ({
    speakText,
    stopSpeaking: stopCurrentPlayback,
  }), [speakText, stopCurrentPlayback]);

  const getColors = () => {
    if (isListening) return { primary: "#ef4444", secondary: "#f97316", accent: "#ec4899" };
    if (isSpeaking) return { primary: "#8b5cf6", secondary: "#6366f1", accent: "#a855f7" };
    if (isConnected) return { primary: "#22c55e", secondary: "#10b981", accent: "#34d399" };
    return { primary: "#6366f1", secondary: "#3b82f6", accent: "#8b5cf6" };
  };

  const colors = getColors();

  return (
    <div
      className="fixed top-0 left-0 right-0 z-50 flex items-center justify-center px-6 py-4"
      style={{
        transform: `translateY(${isVisible ? "0" : "-100%"})`,
        transition: "transform 0.5s cubic-bezier(0.34, 1.56, 0.64, 1)",
      }}
    >
      {/* Center - Visualizer only */}
      <div
        className="flex items-center justify-center cursor-pointer"
        onClick={toggleConnection}
      >
        <div className="relative flex h-8 items-center justify-center gap-[2px]">
          {Array.from({ length: 24 }).map((_, i) => {
            const height = audioLevels[i];
            return (
              <div
                key={i}
                style={{
                  width: "3px",
                  minHeight: "3px",
                  background: `linear-gradient(180deg, ${colors.primary}, ${colors.secondary}, ${colors.accent})`,
                  borderRadius: "2px",
                  transition: isConnected ? "height 0.08s ease-out, background 0.3s ease" : "height 0.15s ease-out, background 0.3s ease",
                  height: `${height}%`,
                }}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
});

export default VoiceNavbar;
