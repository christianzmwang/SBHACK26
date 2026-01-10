"use client";

import { useState, useRef, useEffect, useCallback } from 'react';

interface VoiceAgentProps {
  context: {
    viewMode: string;
    currentQuestion?: any;
    currentQuestionIndex?: number;
    totalQuestions?: number;
    userAnswer?: string;
    showResults?: boolean;
    score?: { correct: number; total: number; percentage: number };
    currentCard?: any;
    currentCardIndex?: number;
    totalCards?: number;
    isFlipped?: boolean;
    stats?: any;
  };
  isOpen: boolean;
  onClose: () => void;
}

interface Caption {
  id: string;
  text: string;
  timestamp: number;
  type: 'user' | 'assistant' | 'system';
}

export default function VoiceAgent({ context, isOpen, onClose }: VoiceAgentProps) {
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
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
  const connectionAttemptRef = useRef(false);

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

  const cleanup = () => {
    connectionAttemptRef.current = false;
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
    setIsConnected(false);
    setIsConnecting(false);
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
      const apiUrl = process.env.NEXT_PUBLIC_API_URL;
      console.log('Fetching token from:', `${apiUrl}/api/voice/token`);
      
      const response = await fetch(`${apiUrl}/api/voice/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
        console.error('Token response error:', response.status, errorData);
        throw new Error(errorData.error || errorData.details || `HTTP ${response.status}`);
      }
      
      const data = await response.json();
      console.log('Token received successfully');
      
      if (!data.access_token) {
        console.error('Token response missing access_token:', data);
        throw new Error('Invalid token response from server');
      }
      
      return data.access_token;
    } catch (err) {
      console.error('Token error:', err);
      const message = err instanceof Error ? err.message : 'Unknown error';
      throw new Error(`Voice service auth failed: ${message}`);
    }
  };

  // Connect to Deepgram WebSocket
  const connectDeepgram = async () => {
    // Prevent multiple simultaneous connection attempts
    if (connectionAttemptRef.current || isConnecting || isConnected) {
      console.log('Connection already in progress or connected');
      return;
    }
    
    connectionAttemptRef.current = true;
    setIsConnecting(true);
    
    try {
      setError(null);
      setCaptions([]); // Clear old captions
      addCaption('Connecting to voice service...', 'system');

      const token = await getDeepgramToken();
      
      // Connect to Deepgram Flux (v2/listen)
      const wsUrl = `wss://api.deepgram.com/v2/listen?model=flux-general-en&encoding=linear16&sample_rate=16000&eager_eot_threshold=0.5&eot_threshold=1.0`;
      
      const ws = new WebSocket(wsUrl, ['token', token]);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('Deepgram WebSocket connected');
        connectionAttemptRef.current = false;
        setIsConnecting(false);
        setIsConnected(true);
        addCaption('Connected! Start speaking...', 'system');
        startRecording();
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          
          if (data.type === 'Connected') {
            console.log('Deepgram session connected:', data.request_id);
          } else if (data.type === 'TurnInfo') {
            handleTurnInfo(data);
          } else if (data.type === 'Error') {
            console.error('Deepgram error:', data);
            setError(data.description || 'Voice service error');
          }
        } catch (err) {
          console.error('Error parsing message:', err);
        }
      };

      ws.onerror = (err) => {
        console.error('WebSocket error:', err);
        connectionAttemptRef.current = false;
        setIsConnecting(false);
        setError('Connection error. Please try again.');
        setIsConnected(false);
      };

      ws.onclose = () => {
        console.log('Deepgram WebSocket closed');
        connectionAttemptRef.current = false;
        setIsConnecting(false);
        setIsConnected(false);
        setIsListening(false);
      };

    } catch (err) {
      console.error('Connection error:', err);
      connectionAttemptRef.current = false;
      setIsConnecting(false);
      setError(err instanceof Error ? err.message : 'Failed to connect');
    }
  };

  // Handle turn info from Deepgram Flux
  const handleTurnInfo = async (data: any) => {
    const { event, transcript, end_of_turn_confidence } = data;

    // Update live transcript
    if (transcript && transcript.trim()) {
      setCurrentTranscript(transcript);
    }

    // Handle events
    if (event === 'StartOfTurn') {
      setIsListening(true);
      setCurrentTranscript('');
    } else if (event === 'EagerEndOfTurn') {
      // User likely finished speaking with moderate confidence
      console.log('Eager end of turn detected, confidence:', end_of_turn_confidence);
      if (transcript && transcript.trim()) {
        await processUserSpeech(transcript);
      }
    } else if (event === 'TurnResumed') {
      // User continued speaking after eager end
      console.log('Turn resumed');
      setIsListening(true);
    } else if (event === 'EndOfTurn') {
      // User definitely finished speaking
      setIsListening(false);
      if (transcript && transcript.trim()) {
        await processUserSpeech(transcript);
      }
      setCurrentTranscript('');
    }
  };

  // Process user speech and get AI response
  const processUserSpeech = async (transcript: string) => {
    try {
      addCaption(transcript, 'user');

      // Stream response from backend
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/voice/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript, context }),
      });

      if (!response.ok) {
        throw new Error('Failed to get response');
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let fullText = '';

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value);
          const lines = chunk.split('\n');

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6));
                if (data.text) {
                  fullText += data.text;
                }
                if (data.done) {
                  // Convert to speech
                  await speakText(fullText);
                  addCaption(fullText, 'assistant');
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
      }
    } catch (err) {
      console.error('Process speech error:', err);
      setError('Failed to process your message');
    }
  };

  // Convert text to speech using Deepgram TTS
  const speakText = async (text: string) => {
    try {
      setIsSpeaking(true);
      
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/voice/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });

      if (!response.ok) {
        throw new Error('Failed to generate speech');
      }

      const audioBlob = await response.blob();
      const audioUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(audioUrl);

      audio.onended = () => {
        setIsSpeaking(false);
        URL.revokeObjectURL(audioUrl);
      };

      audio.onerror = () => {
        setIsSpeaking(false);
        URL.revokeObjectURL(audioUrl);
      };

      await audio.play();
    } catch (err) {
      console.error('Speech synthesis error:', err);
      setIsSpeaking(false);
    }
  };

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
    if (isConnected || isConnecting) {
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <div className="relative w-full max-w-2xl max-h-[90vh] bg-slate-900 border border-slate-700 shadow-2xl flex flex-col">
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
              className={`flex ${caption.type === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[80%] px-4 py-3 rounded-lg ${
                  caption.type === 'user'
                    ? 'bg-indigo-600 text-white'
                    : caption.type === 'assistant'
                    ? 'bg-slate-700 text-white'
                    : 'bg-slate-800 text-slate-400 text-sm italic'
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

          {/* Speaking indicator */}
          {isSpeaking && (
            <div className="flex justify-start">
              <div className="bg-slate-700 px-4 py-3 rounded-lg">
                <div className="flex items-center gap-2">
                  <div className="flex gap-1">
                    <div className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                    <div className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                    <div className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                  </div>
                  <span className="text-slate-300 text-sm">Assistant is speaking...</span>
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
              disabled={isSpeaking}
              className={`relative w-20 h-20 rounded-full flex items-center justify-center transition-all transform hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed ${
                isConnecting
                  ? 'bg-amber-500 hover:bg-amber-600 shadow-lg shadow-amber-500/50 animate-pulse'
                  : isConnected
                    ? isListening
                      ? 'bg-red-500 hover:bg-red-600 shadow-lg shadow-red-500/50 animate-pulse'
                      : 'bg-indigo-600 hover:bg-indigo-700 shadow-lg shadow-indigo-500/50'
                    : 'bg-white hover:bg-slate-200'
              }`}
              aria-label={isConnecting ? 'Connecting...' : isConnected ? 'Stop voice assistant' : 'Start voice assistant'}
            >
              {isConnecting ? (
                <div className="h-8 w-8 border-3 border-white border-t-transparent rounded-full animate-spin" />
              ) : isConnected ? (
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
                {isConnecting
                  ? 'Connecting...'
                  : isConnected 
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
                    ? 'Quiz Results'
                    : context.viewMode === 'quiz'
                    ? `Quiz Question ${context.currentQuestionIndex! + 1}`
                    : context.viewMode === 'flashcards'
                    ? `Flashcard ${context.currentCardIndex! + 1}`
                    : 'Practice Overview'}
                </span>
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
