"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { useSession } from "next-auth/react";
import { foldersApi, Folder, MaterialSection } from "@/lib/api";
import { useData } from "@/app/context/DataContext";

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
  const { data: session } = useSession();
  const { refreshFolders: refreshGlobalFolders } = useData();
  const [mode, setMode] = useState<"talk" | "record">("talk");
  const [isActive, setIsActive] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [audioLevels, setAudioLevels] = useState<number[]>(Array(48).fill(8));
  
  // Save modal state
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [selectedFolderId, setSelectedFolderId] = useState<string>("");
  const [selectedSectionId, setSelectedSectionId] = useState<string>("");
  const [newSectionTitle, setNewSectionTitle] = useState("");
  const [transcriptTitle, setTranscriptTitle] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const idleAnimationRef = useRef<number | null>(null);
  const isAnalyzingRef = useRef(false);

  // Idle animation for bars when not recording
  useEffect(() => {
    if (isActive) {
      // Stop idle animation when recording starts
      if (idleAnimationRef.current) {
        cancelAnimationFrame(idleAnimationRef.current);
        idleAnimationRef.current = null;
      }
      return;
    }

    // Run idle animation
    let startTime: number | null = null;
    
    const animateIdle = (timestamp: number) => {
      if (!startTime) startTime = timestamp;
      const elapsed = timestamp - startTime;
      
      const newLevels = Array.from({ length: 48 }, (_, i) => {
        // Create wave-like motion from center
        const centerIndex = 23.5;
        const distanceFromCenter = Math.abs(i - centerIndex);
        
        // Multiple wave frequencies for organic movement
        const wave1 = Math.sin((elapsed / 1000) * 1.5 + i * 0.15) * 12;
        const wave2 = Math.sin((elapsed / 1000) * 2.3 + i * 0.1) * 8;
        const wave3 = Math.sin((elapsed / 1000) * 0.7 + distanceFromCenter * 0.2) * 6;
        
        // Base height + combined waves
        const level = 15 + wave1 + wave2 + wave3;
        return Math.max(8, Math.min(40, level));
      });
      
      setAudioLevels(newLevels);
      idleAnimationRef.current = requestAnimationFrame(animateIdle);
    };
    
    idleAnimationRef.current = requestAnimationFrame(animateIdle);
    
    return () => {
      if (idleAnimationRef.current) {
        cancelAnimationFrame(idleAnimationRef.current);
        idleAnimationRef.current = null;
      }
    };
  }, [isActive]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      stopRecording();
      if (idleAnimationRef.current) {
        cancelAnimationFrame(idleAnimationRef.current);
      }
    };
  }, []);

  // Load folders when save modal opens
  useEffect(() => {
    if (showSaveModal && session?.user?.id) {
      // Reset section states when modal opens
      setSelectedSectionId("");
      setNewSectionTitle("");
      setSaveError(null);
      loadFolders();
    }
  }, [showSaveModal, session?.user?.id]);

  const loadFolders = async () => {
    if (!session?.user?.id) return;
    try {
      const folderList = await foldersApi.list(session.user.id);
      setFolders(folderList);
      if (folderList.length > 0) {
        setSelectedFolderId(folderList[0].id);
      }
    } catch (err) {
      console.error("Failed to load folders:", err);
      setSaveError("Failed to load folders. Please try again.");
    }
  };

  // Get sections for selected folder
  const getSelectedFolderSections = (): MaterialSection[] => {
    const folder = folders.find(f => f.id === selectedFolderId);
    return folder?.sections || [];
  };

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

  const stopRecording = (skipModal = false) => {
    // Check if we should show save modal (record mode with transcript content)
    const hasTranscriptContent = transcript.trim().length > 0 || interimTranscript.trim().length > 0;
    const shouldShowSaveModal = mode === "record" && hasTranscriptContent && !skipModal;

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

    // Show save modal if conditions met
    if (shouldShowSaveModal) {
      // Use a small delay to ensure transcript state is updated
      setTimeout(() => {
        setShowSaveModal(true);
        setSaveSuccess(false);
        setSaveError(null);
      }, 100);
    }
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

  const handleSaveTranscript = async () => {
    if (!session?.user?.id) {
      setSaveError("Please sign in to save transcripts");
      return;
    }

    const fullTranscript = `${transcript}${interimTranscript ? " " + interimTranscript : ""}`.trim();
    if (!fullTranscript) {
      setSaveError("No transcript to save");
      return;
    }

    if (!selectedFolderId) {
      setSaveError("Please select a folder");
      return;
    }

    // Check if user has either selected a section OR entered a new section name
    const hasExistingSection = selectedSectionId && selectedSectionId.trim() !== "";
    const hasNewSection = newSectionTitle && newSectionTitle.trim() !== "";
    
    if (!hasExistingSection && !hasNewSection) {
      setSaveError("Please select a section or enter a new section name");
      return;
    }

    setIsSaving(true);
    setSaveError(null);

    try {
      let targetSectionId = selectedSectionId;

      // Create new section if user entered a name
      if (hasNewSection) {
        const newSection = await foldersApi.createFolderSection(
          selectedFolderId,
          newSectionTitle.trim(),
          "Voice recordings and transcripts",
          "lecture_notes"
        );
        targetSectionId = newSection.id;
      }

      // Save the transcript
      await foldersApi.uploadTranscript(
        targetSectionId,
        fullTranscript,
        transcriptTitle.trim() || "Voice Recording"
      );

      // Refresh global folders cache so course material page shows the new content
      refreshGlobalFolders();

      setSaveSuccess(true);
      
      // Clear transcript and close modal after success
      setTimeout(() => {
        setTranscript("");
        setInterimTranscript("");
        setShowSaveModal(false);
        setTranscriptTitle("");
        setNewSectionTitle("");
        setSaveSuccess(false);
      }, 1500);
    } catch (err) {
      console.error("Failed to save transcript:", err);
      setSaveError(err instanceof Error ? err.message : "Failed to save transcript");
    } finally {
      setIsSaving(false);
    }
  };

  const closeSaveModal = () => {
    setShowSaveModal(false);
    setTranscriptTitle("");
    setNewSectionTitle("");
    setSaveError(null);
    setSaveSuccess(false);
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
              // audioLevels is now animated via JS for both idle and active states
              const height = audioLevels[i];

              return (
                <div
                  key={i}
                  className="relative"
                  style={{
                    width: "5px",
                    minHeight: "3px",
                    background: `linear-gradient(180deg, ${colors.primary}, ${colors.secondary}, ${colors.accent})`,
                    borderRadius: "3px",
                    transition: isActive
                      ? "height 0.08s ease-out, background 0.3s ease"
                      : "height 0.1s ease-out, background 0.3s ease",
                    height: `${height}%`,
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
            <div className="flex items-center gap-4 px-4">
              {mode === "record" && (
                <button
                  onClick={() => {
                    setShowSaveModal(true);
                    setSaveSuccess(false);
                    setSaveError(null);
                  }}
                  className="text-xs text-slate-500 hover:text-white transition-colors cursor-pointer">
                  Save
                </button>
              )}
              <button
                onClick={clearTranscript}
                className="text-xs text-slate-500 hover:text-white transition-colors cursor-pointer">
                Clear
              </button>
            </div>
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

      {/* Save Transcript Modal */}
      {showSaveModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={closeSaveModal}>
          <div className="bg-black/30 backdrop-blur-md border border-white/10 max-w-3xl w-full max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            {/* Modal Header */}
            <div className="flex items-center justify-between p-4 border-b border-white/10">
              <h2 className="text-sm font-semibold text-white">Save Transcript</h2>
              <button
                onClick={closeSaveModal}
                className="text-slate-400 hover:text-white transition cursor-pointer"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Modal Content */}
            <div className="p-4">
              {saveSuccess ? (
                <div className="text-center py-8">
                  <div className="w-16 h-16 mx-auto mb-4 bg-green-500/20 flex items-center justify-center">
                    <svg className="w-8 h-8 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                  <p className="text-green-400 font-medium">Saved & processed!</p>
                  <p className="text-slate-400 text-sm mt-1">Ready for practice material generation</p>
                </div>
              ) : (
                <>
                  {/* Transcript Preview */}
                  <div className="mb-4">
                    <label className="block text-sm font-medium text-slate-300 mb-2">
                      Transcript Preview
                    </label>
                    <div className="bg-slate-800/50 border border-white/10 p-3 max-h-24 overflow-y-auto text-sm text-slate-300">
                      {transcript}{interimTranscript && <span className="text-slate-500 italic"> {interimTranscript}</span>}
                    </div>
                  </div>

                  {/* Horizontal Layout: Title, Folder, Section */}
                  <div className="grid grid-cols-3 gap-4 mb-4">
                    {/* Title Input */}
                    <div>
                      <label className="block text-sm font-medium text-slate-300 mb-2">
                        Title
                      </label>
                      <input
                        type="text"
                        value={transcriptTitle}
                        onChange={(e) => setTranscriptTitle(e.target.value)}
                        placeholder="Voice Recording"
                        className="w-full bg-slate-800/50 border border-white/10 px-3 py-2 text-white placeholder-slate-500 focus:outline-none focus:border-white/30"
                      />
                    </div>

                    {/* Folder Selection */}
                    <div>
                      <label className="block text-sm font-medium text-slate-300 mb-2">
                        Folder
                      </label>
                      {folders.length === 0 ? (
                        <p className="text-sm text-slate-500">No folders found.</p>
                      ) : (
                        <select
                          value={selectedFolderId}
                          onChange={(e) => {
                            setSelectedFolderId(e.target.value);
                            setSelectedSectionId("");
                            setNewSectionTitle("");
                          }}
                          className="w-full bg-slate-800/50 border border-white/10 px-3 py-2 text-white focus:outline-none focus:border-white/30"
                        >
                          {folders.map((folder) => (
                            <option key={folder.id} value={folder.id}>
                              {folder.name}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>

                    {/* Section Selection */}
                    <div>
                      <label className="block text-sm font-medium text-slate-300 mb-2">
                        Section <span className="text-red-400">*</span>
                      </label>
                      {selectedFolderId ? (
                        getSelectedFolderSections().length > 0 ? (
                          <select
                            value={newSectionTitle.trim() ? "" : selectedSectionId}
                            onChange={(e) => {
                              if (e.target.value) {
                                setSelectedSectionId(e.target.value);
                                setNewSectionTitle("");
                              } else {
                                setSelectedSectionId("");
                              }
                            }}
                            className="w-full bg-slate-800/50 border border-white/10 px-3 py-2 text-white focus:outline-none focus:border-white/30"
                            disabled={!!newSectionTitle.trim()}
                          >
                            <option value="">Select a section...</option>
                            {getSelectedFolderSections().map((section) => (
                              <option key={section.id} value={section.id}>
                                {section.title}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <p className="text-sm text-slate-400 py-2">No sections. Create one below.</p>
                        )
                      ) : (
                        <p className="text-sm text-slate-500 py-2">Select a folder first</p>
                      )}
                    </div>
                  </div>

                  {/* Create New Section Row */}
                  {selectedFolderId && (
                    <div className="mb-4">
                      <div className="flex items-center gap-4">
                        {getSelectedFolderSections().length > 0 && (
                          <span className="text-slate-500 text-sm whitespace-nowrap">or create new:</span>
                        )}
                        <input
                          type="text"
                          value={newSectionTitle}
                          onChange={(e) => {
                            setNewSectionTitle(e.target.value);
                            // Clear existing section selection when typing new section name
                            if (e.target.value.trim()) {
                              setSelectedSectionId("");
                            }
                          }}
                          placeholder="New section name..."
                          className="flex-1 bg-slate-800/50 border border-white/10 px-3 py-2 text-white placeholder-slate-500 focus:outline-none focus:border-white/30"
                        />
                      </div>
                    </div>
                  )}

                  {/* Error Message */}
                  {saveError && (
                    <div className="bg-red-500/10 border border-red-500/30 p-3 mb-4">
                      <p className="text-sm text-red-400">{saveError}</p>
                    </div>
                  )}

                  {/* Actions */}
                  <div className="flex gap-3 justify-end">
                    <button
                      onClick={closeSaveModal}
                      className="px-6 py-2 border border-white/20 text-slate-300 hover:bg-white hover:border-white hover:text-black transition cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleSaveTranscript}
                      disabled={isSaving || !selectedFolderId || folders.length === 0 || (!selectedSectionId && !newSectionTitle.trim())}
                      className="px-6 py-2 bg-white text-black font-semibold border border-white hover:bg-black hover:text-white transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                    >
                      {isSaving ? "Processing..." : "Save"}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* CSS Styles */}
      <style jsx>{`
        /* Hide scrollbar */
        div::-webkit-scrollbar {
          display: none;
        }
      `}</style>
    </div>
  );
}
