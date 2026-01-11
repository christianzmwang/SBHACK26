"use client";

import { useState, useRef, useCallback, useEffect } from "react";

interface TranscriptWord {
  word: string;
  start: number;
  end: number;
  confidence: number;
  punctuated_word: string;
}

interface TranscriptAlternative {
  transcript: string;
  confidence: number;
  words: TranscriptWord[];
}

interface DeepgramResponse {
  type: string;
  channel: {
    alternatives: TranscriptAlternative[];
  };
  is_final: boolean;
  speech_final: boolean;
}

export default function VoicePage() {
  const [mode, setMode] = useState<"talk" | "record">("talk");
  const [isActive, setIsActive] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [audioLevels, setAudioLevels] = useState<number[]>(Array(48).fill(8));

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const isAnalyzingRef = useRef(false);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      stopRecording();
    };
  }, []);

  // Analyze audio levels for visualization
  const analyzeAudio = useCallback(() => {
    if (!analyserRef.current || !isAnalyzingRef.current) return;

    const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
    analyserRef.current.getByteFrequencyData(dataArray);

    // Focus on voice frequencies (roughly 80Hz - 3000Hz) which are in the lower bins
    // Use only the first ~40% of frequency data where voice lives
    const voiceDataLength = Math.floor(dataArray.length * 0.4);
    const barCount = 48;
    const halfBars = barCount / 2; // 24 bars per side
    const samplesPerBar = Math.floor(voiceDataLength / halfBars);
    
    // Create levels for one half (center to edge)
    const halfLevels: number[] = [];
    for (let i = 0; i < halfBars; i++) {
      let sum = 0;
      for (let j = 0; j < samplesPerBar; j++) {
        sum += dataArray[i * samplesPerBar + j];
      }
      const average = sum / samplesPerBar;
      // Convert to percentage (8% min, 95% max)
      const level = Math.max(8, Math.min(95, (average / 255) * 100 + 8));
      halfLevels.push(level);
    }

    // Mirror the levels: center bars get low frequencies, outer bars get higher frequencies
    // Left side: reversed (high freq on far left, low freq in center-left)
    // Right side: normal (low freq in center-right, high freq on far right)
    const levels: number[] = [
      ...halfLevels.slice().reverse(), // Left half (mirrored)
      ...halfLevels,                    // Right half
    ];

    setAudioLevels(levels);
    animationFrameRef.current = requestAnimationFrame(analyzeAudio);
  }, []);

  const startRecording = async () => {
    try {
      setError(null);

      // Get Deepgram API key from our API route
      const response = await fetch("/api/deepgram");
      if (!response.ok) {
        throw new Error("Failed to get Deepgram API key");
      }
      const { apiKey } = await response.json();

      // Request microphone access
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 16000,
        },
      });
      streamRef.current = stream;

      // Set up audio analysis for visualization
      audioContextRef.current = new AudioContext();
      analyserRef.current = audioContextRef.current.createAnalyser();
      analyserRef.current.fftSize = 256;
      const source = audioContextRef.current.createMediaStreamSource(stream);
      source.connect(analyserRef.current);

      // Start audio level animation
      isAnalyzingRef.current = true;
      animationFrameRef.current = requestAnimationFrame(analyzeAudio);

      // Connect to Deepgram WebSocket
      const socket = new WebSocket(
        `wss://api.deepgram.com/v1/listen?model=nova-2&language=en-US&smart_format=true&interim_results=true&endpointing=300`,
        ["token", apiKey]
      );
      socketRef.current = socket;

      socket.onopen = () => {
        console.log("Deepgram connection opened");

        // Create MediaRecorder
        const mediaRecorder = new MediaRecorder(stream, {
          mimeType: "audio/webm;codecs=opus",
        });
        mediaRecorderRef.current = mediaRecorder;

        mediaRecorder.ondataavailable = (event) => {
          if (event.data.size > 0 && socket.readyState === WebSocket.OPEN) {
            socket.send(event.data);
          }
        };

        // Send audio data every 250ms
        mediaRecorder.start(250);
      };

      socket.onmessage = (event) => {
        const data: DeepgramResponse = JSON.parse(event.data);

        if (data.type === "Results" && data.channel?.alternatives?.[0]) {
          const alternative = data.channel.alternatives[0];
          const text = alternative.transcript;

          if (text) {
            if (data.is_final) {
              // Append final transcript
              setTranscript((prev) => {
                const newText = prev ? `${prev} ${text}` : text;
                return newText;
              });
              setInterimTranscript("");
            } else {
              // Update interim transcript
              setInterimTranscript(text);
            }
          }
        }
      };

      socket.onerror = (event) => {
        console.error("Deepgram WebSocket error:", event);
        setError("Connection error occurred");
      };

      socket.onclose = (event) => {
        console.log("Deepgram connection closed:", event.code, event.reason);
        if (event.code !== 1000) {
          setError(`Connection closed: ${event.reason || "Unknown reason"}`);
        }
      };

      setIsActive(true);
    } catch (err) {
      console.error("Error starting recording:", err);
      setError(
        err instanceof Error ? err.message : "Failed to start recording"
      );
      setIsActive(false);
    }
  };

  const stopRecording = () => {
    // Stop animation frame
    isAnalyzingRef.current = false;
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    // Stop MediaRecorder
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
    }

    // Close WebSocket
    if (socketRef.current) {
      if (socketRef.current.readyState === WebSocket.OPEN) {
        socketRef.current.close(1000, "User stopped recording");
      }
      socketRef.current = null;
    }

    // Stop audio tracks
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    // Close audio context
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    // Reset audio levels
    setAudioLevels(Array(48).fill(8));
    setIsActive(false);
  };

  const handleButtonClick = () => {
    if (isActive) {
      stopRecording();
    } else {
      startRecording();
    }
  };

  const clearTranscript = () => {
    setTranscript("");
    setInterimTranscript("");
  };

  // Color configurations for each mode - sci-fi aesthetic
  const colorConfig = {
    talk: {
      primary: "#00ff9f",
      secondary: "#00b8ff",
      accent: "#0affef",
      text: "text-emerald-400",
      button: "bg-emerald-500",
    },
    record: {
      primary: "#ff003c",
      secondary: "#ff6b00",
      accent: "#ff0080",
      text: "text-red-400",
      button: "bg-red-500",
    },
  };

  const colors = colorConfig[mode];

  return (
    <div className="fixed inset-0 top-[73px] bottom-[57px] flex flex-col items-center justify-center overflow-hidden bg-black">
      {/* Mode Toggle - Top Right */}
      <div className="absolute right-6 top-6 flex gap-3 z-10">
        <button
          onClick={() => setMode("talk")}
          className={`px-4 py-2 text-sm font-semibold transition cursor-pointer ${
            mode === "talk"
              ? "bg-white border border-white text-black hover:bg-black hover:text-white"
              : "border border-white text-white hover:bg-white hover:text-black"
          }`}
        >
          Talk
        </button>
        <button
          onClick={() => setMode("record")}
          className={`px-4 py-2 text-sm font-semibold transition cursor-pointer ${
            mode === "record"
              ? "bg-white border border-white text-black hover:bg-black hover:text-white"
              : "border border-white text-white hover:bg-white hover:text-black"
          }`}
        >
          Record
        </button>
      </div>

      {/* Voice Line Visualizer - Centered */}
      <div className="flex flex-col items-center">
        <button
          onClick={handleButtonClick}
          className="relative flex h-56 w-[480px] cursor-pointer items-center justify-center focus:outline-none"
          style={{
            transform: isActive ? "scale(1.05)" : "scale(1)",
            transition: "transform 0.6s cubic-bezier(0.34, 1.56, 0.64, 1)",
          }}
        >
          {/* Voice line bars container */}
          <div className="relative flex h-full w-full items-center justify-center gap-[3px]">
            {/* Generate 48 bars for the voice line */}
            {Array.from({ length: 48 }).map((_, i) => {
              // Use real audio levels when active, otherwise use default animation
              const activeHeight = isActive ? audioLevels[i] : 8;

              // Stagger the activation delay from center outward for a ripple effect
              const centerIndex = 23.5;
              const distanceFromCenter = Math.abs(i - centerIndex);
              const activationDelay = distanceFromCenter * 0.015;

              // Animation timing varies by position (only for idle state)
              const animationDuration = !isActive ? 1.5 + (i % 5) * 0.3 : 0;
              const animationDelay = !isActive ? i * 0.08 : 0;

              return (
                <div
                  key={i}
                  className="relative"
                  style={{
                    width: "5px",
                    minHeight: "3px",
                    background: `linear-gradient(180deg, ${colors.primary}, ${colors.secondary}, ${colors.accent})`,
                    borderRadius: "3px",
                    animation: !isActive
                      ? `voiceBarIdle ${animationDuration}s ease-in-out ${animationDelay}s infinite alternate`
                      : "none",
                    transition: isActive
                      ? "height 0.05s ease-out"
                      : `height 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) ${activationDelay}s`,
                    height: `${activeHeight}%`,
                  }}
                />
              );
            })}
          </div>
        </button>

        {/* Status Text - Only shown when inactive */}
        <p
          className="mt-6 text-center text-lg text-slate-300"
          style={{
            opacity: isActive ? 0 : 1,
            transition: "opacity 0.4s ease",
          }}
        >
          {`Press to ${mode === "talk" ? "start talking" : "start recording"}`}
        </p>

        {/* Error Message */}
        {error && (
          <p className="mt-2 text-center text-sm text-red-500">{error}</p>
        )}
      </div>

      {/* Transcript Display - Appears when active */}
      <div 
        className="absolute bottom-0 left-0 right-0 w-full max-w-2xl mx-auto pb-6 flex flex-col"
        style={{
          opacity: isActive ? 1 : 0,
          transform: isActive ? "translateY(0)" : "translateY(40px)",
          transition: "opacity 0.5s ease, transform 0.5s ease",
          pointerEvents: isActive ? "auto" : "none",
          height: "200px",
        }}
      >
        <div className="relative flex items-center justify-between mb-3 z-10">
          <h3 className="text-sm font-medium text-slate-400 px-4">Transcript</h3>
          {(transcript || interimTranscript) && (
            <button
              onClick={clearTranscript}
              className="text-xs px-10 text-slate-500 hover:text-white transition-colors cursor-pointer">
              Clear
            </button>
          )}
        </div>
        
        {/* Scrollable transcript with fade at bottom - flipped so new text appears at top */}
        <div className="relative flex-1 overflow-hidden">
          <div
            className="h-full overflow-y-auto px-4 pt-2"
            style={{ 
              scrollbarWidth: "none",
              msOverflowStyle: "none",
              transform: "scaleY(-1)",
            }}
          >
            <div style={{ transform: "scaleY(-1)", paddingTop: "2rem" }}>
              {(transcript || interimTranscript) && (
                <p className="text-slate-200 leading-relaxed">
                  {transcript}
                  {interimTranscript && (
                    <span className="text-slate-400 italic">
                      {transcript ? " " : ""}
                      {interimTranscript}
                    </span>
                  )}
                </p>
              )}
            </div>
          </div>
          
          {/* Fade gradient at top where new text appears from */}
          <div 
            className="absolute left-0 right-0 h-24 pointer-events-none"
            style={{
              top: "-1rem",
              background: "linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,0.8) 50%, transparent 100%)",
            }}
          />
        </div>
      </div>

      {/* CSS Keyframes */}
      <style jsx>{`
        @keyframes voiceBarIdle {
          0% {
            transform: scaleY(1);
            opacity: 0.4;
          }
          50% {
            transform: scaleY(2.5);
            opacity: 0.7;
          }
          100% {
            transform: scaleY(1);
            opacity: 0.4;
          }
        }
        
        /* Hide scrollbar */
        div::-webkit-scrollbar {
          display: none;
        }
      `}</style>
    </div>
  );
}
