"use client";

import { useState, useEffect, Suspense } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { 
  foldersApi,
  type MaterialSection,
  type FileItem,
  type FileWarning
} from "@/lib/api";

// Helper to format file size
const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
};

// Helper to detect garbled text (custom font encoding issues)
const isTextGarbled = (text: string): boolean => {
  if (!text || text.length < 100) return false;
  
  const sample = text.substring(0, 1000).toLowerCase();
  
  // Check for common English words
  const commonWords = ['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'with', 'this', 'that', 'from', 'have', 'been'];
  const foundCommonWords = commonWords.filter(word => sample.includes(word)).length;
  
  // Check for unusual character sequences
  const unusualPatterns = (sample.match(/[=\]\[]{2,}|[^a-z0-9\s.,!?;:'"()-]{3,}/g) || []).length;
  
  // Check ratio of special characters
  const letters = (sample.match(/[a-z]/g) || []).length;
  const specialChars = (sample.match(/[=\]\[@#$%^&*]/g) || []).length;
  
  let score = 0;
  if (foundCommonWords < 3) score += 3;
  if (unusualPatterns > 10) score += 2;
  if (specialChars > letters * 0.1) score += 2;
  
  return score >= 4;
};

function PreviewContent() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session } = useSession();
  const sectionId = params.sectionId as string;
  const foldersParam = searchParams.get('folders');

  const [section, setSection] = useState<MaterialSection | null>(null);
  const [selectedFile, setSelectedFile] = useState<FileItem | null>(null);
  const [fileTextContent, setFileTextContent] = useState<string | null>(null);
  const [isLoadingContent, setIsLoadingContent] = useState(false);
  const [isLoadingSection, setIsLoadingSection] = useState(true);
  const [contentMessage, setContentMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [uploadWarnings, setUploadWarnings] = useState<FileWarning[]>([]);
  const [isContentGarbled, setIsContentGarbled] = useState(false);

  // Navigate back to the correct folder
  const handleBack = () => {
    if (foldersParam) {
      router.push(`/course-material?folders=${foldersParam}`);
    } else {
      router.push('/course-material');
    }
  };

  // Load section data
  useEffect(() => {
    const loadSection = async () => {
      try {
        setIsLoadingSection(true);
        const sectionData = await foldersApi.getSection(sectionId);
        setSection(sectionData);
        // Auto-select first file if available (skip processing files)
        if (sectionData.files.length > 0) {
          const firstProcessedFile = sectionData.files.find(f => !f.processing);
          if (firstProcessedFile) {
            setSelectedFile(firstProcessedFile);
          }
        }
      } catch (err) {
        console.error('Failed to load section:', err);
        setError('Failed to load section');
      } finally {
        setIsLoadingSection(false);
      }
    };

    if (sectionId) {
      loadSection();
    }
  }, [sectionId]);

  // Fetch file content when a file is selected
  useEffect(() => {
    // Don't fetch content for processing files
    if (selectedFile?.id && !selectedFile.processing) {
      const fetchContent = async () => {
        setIsLoadingContent(true);
        setFileTextContent(null);
        setContentMessage(null);
        setIsContentGarbled(false);
        try {
          const result = await foldersApi.getFileContent(selectedFile.id);
          setFileTextContent(result.textContent);
          // Check if content appears garbled
          if (result.textContent && isTextGarbled(result.textContent)) {
            setIsContentGarbled(true);
          }
          if (result.message) {
            setContentMessage(result.message);
          }
        } catch (err) {
          console.error('Failed to fetch file content:', err);
          setContentMessage('Failed to load file content');
        } finally {
          setIsLoadingContent(false);
        }
      };
      fetchContent();
    } else if (selectedFile?.processing) {
      setFileTextContent(null);
      setContentMessage('File is currently being processed...');
      setIsContentGarbled(false);
    } else {
      setFileTextContent(null);
      setContentMessage(null);
      setIsContentGarbled(false);
    }
  }, [selectedFile?.id, selectedFile?.processing]);

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!section) return;
    
    const files = event.target.files;
    if (!files || files.length === 0) return;

    // Create temporary file items with processing status - use unique batch ID
    const batchId = Date.now();
    const tempFileIds = Array.from(files).map((_, index) => `temp-${batchId}-${index}`);
    const tempFiles: FileItem[] = Array.from(files).map((file, index) => ({
      id: tempFileIds[index],
      name: file.name,
      uploadDate: new Date().toISOString(),
      size: formatFileSize(file.size),
      processing: true,
    }));

    // Capture the current non-processing file count BEFORE adding temp files
    const originalFileCount = section.files.filter(f => !f.processing).length;
    const sectionId = section.id;

    // Add files to the list immediately
    setSection((prev) => 
      prev ? { ...prev, files: [...prev.files, ...tempFiles] } : null
    );

    try {
      const { files: uploadedFiles, warnings } = await foldersApi.uploadFiles(
        sectionId,
        Array.from(files)
      );

      // Replace only THIS batch's temporary files with actual uploaded files
      setSection((prev) => {
        if (!prev) return null;
        // Remove only the temp files from this batch, keep others
        const remainingFiles = prev.files.filter(f => !tempFileIds.includes(f.id));
        return { ...prev, files: [...remainingFiles, ...uploadedFiles] };
      });

      // Auto-select the first uploaded file if no file is currently selected
      if (uploadedFiles.length > 0) {
        setSelectedFile((prev) => prev || uploadedFiles[0]);
      }

      // Show any warnings about the uploaded files
      if (warnings && warnings.length > 0) {
        setUploadWarnings(warnings);
      }
    } catch (err) {
      // Poll for completion - backend may still be processing
      // Try up to 10 times with 3 second delays (30 seconds total)
      for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 3000));
        try {
          const refreshedSection = await foldersApi.getSection(sectionId);
          // If files were added compared to original count, update and return
          const newNonProcessingCount = refreshedSection.files.filter(f => !f.processing).length;
          if (newNonProcessingCount > originalFileCount) {
            setSection(refreshedSection);
            // Auto-select first new file
            const newFiles = refreshedSection.files.filter(f => !f.processing);
            if (newFiles.length > 0) {
              setSelectedFile((prev) => prev || newFiles[newFiles.length - 1]);
            }
            return;
          }
        } catch {
          // Ignore refresh errors, keep polling
        }
      }
      
      // If we get here, the upload truly failed - remove only this batch's temp files
      setSection((prev) => {
        if (!prev) return null;
        return { ...prev, files: prev.files.filter(f => !tempFileIds.includes(f.id)) };
      });
      setError(err instanceof Error ? err.message : 'Upload failed');
    }
  };

  const handleFileDrop = async (files: File[]) => {
    if (!section || files.length === 0) return;

    // Create temporary file items with processing status - use unique batch ID
    const batchId = Date.now();
    const tempFileIds = files.map((_, index) => `temp-${batchId}-${index}`);
    const tempFiles: FileItem[] = files.map((file, index) => ({
      id: tempFileIds[index],
      name: file.name,
      uploadDate: new Date().toISOString(),
      size: formatFileSize(file.size),
      processing: true,
    }));

    // Capture the current non-processing file count BEFORE adding temp files
    const originalFileCount = section.files.filter(f => !f.processing).length;
    const sectionId = section.id;

    // Add files to the list immediately
    setSection((prev) => 
      prev ? { ...prev, files: [...prev.files, ...tempFiles] } : null
    );

    try {
      const { files: uploadedFiles, warnings } = await foldersApi.uploadFiles(
        sectionId,
        files
      );

      // Replace only THIS batch's temporary files with actual uploaded files
      setSection((prev) => {
        if (!prev) return null;
        // Remove only the temp files from this batch, keep others
        const remainingFiles = prev.files.filter(f => !tempFileIds.includes(f.id));
        return { ...prev, files: [...remainingFiles, ...uploadedFiles] };
      });

      // Auto-select the first uploaded file if no file is currently selected
      if (uploadedFiles.length > 0) {
        setSelectedFile((prev) => prev || uploadedFiles[0]);
      }

      // Show any warnings about the uploaded files
      if (warnings && warnings.length > 0) {
        setUploadWarnings(warnings);
      }
    } catch (err) {
      // Poll for completion - backend may still be processing
      // Try up to 10 times with 3 second delays (30 seconds total)
      for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 3000));
        try {
          const refreshedSection = await foldersApi.getSection(sectionId);
          // If files were added compared to original count, update and return
          const newNonProcessingCount = refreshedSection.files.filter(f => !f.processing).length;
          if (newNonProcessingCount > originalFileCount) {
            setSection(refreshedSection);
            // Auto-select first new file
            const newFiles = refreshedSection.files.filter(f => !f.processing);
            if (newFiles.length > 0) {
              setSelectedFile((prev) => prev || newFiles[newFiles.length - 1]);
            }
            return;
          }
        } catch {
          // Ignore refresh errors, keep polling
        }
      }
      
      // If we get here, the upload truly failed - remove only this batch's temp files
      setSection((prev) => {
        if (!prev) return null;
        return { ...prev, files: prev.files.filter(f => !tempFileIds.includes(f.id)) };
      });
      setError(err instanceof Error ? err.message : 'Upload failed');
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files);
    const validFiles = files.filter(file => 
      ['.pdf', '.docx', '.doc', '.txt', '.md', '.tex', '.mp3'].some(ext => 
        file.name.toLowerCase().endsWith(ext)
      )
    );

    if (validFiles.length > 0) {
      handleFileDrop(validFiles);
    } else {
      setError('Please drop valid files (.pdf, .docx, .doc, .txt, .md, .tex, .mp3)');
    }
  };

  const handleDeleteFile = async (fileId: string) => {
    if (!section) return;

    try {
      await foldersApi.deleteFile(fileId);

      // If the deleted file was selected, clear the selection
      if (selectedFile?.id === fileId) {
        setSelectedFile(null);
      }

      setSection((prev) => {
        if (!prev) return null;
        const remainingFiles = prev.files.filter((f) => f.id !== fileId);
        
        // If there are remaining files and we just cleared the selection, select the first one
        if (selectedFile?.id === fileId && remainingFiles.length > 0) {
          // Find first non-processing file
          const firstProcessedFile = remainingFiles.find(f => !f.processing);
          if (firstProcessedFile) {
            setSelectedFile(firstProcessedFile);
          }
        }
        
        return { ...prev, files: remainingFiles };
      });
    } catch (err) {
      console.error('Failed to delete file:', err);
      setError('Failed to delete file');
    }
  };

  if (isLoadingSection) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="flex items-center gap-3 text-slate-400">
          <div className="animate-spin h-6 w-6 border-2 border-slate-400 border-t-transparent rounded-full" />
          <span>Loading section...</span>
        </div>
      </div>
    );
  }

  if (!section) {
    return (
      <div className="h-full flex items-center justify-center bg-black">
        <div className="text-center">
          <p className="text-slate-400">Section not found</p>
          <button
            onClick={handleBack}
            className="mt-4 border border-white px-4 py-2 text-sm font-semibold text-white transition hover:bg-white hover:text-black cursor-pointer"
          >
            Go Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col -mt-4 bg-black">
      {/* Header */}
      <div className="flex-shrink-0 pb-6 bg-black">
        <div className="flex items-start justify-between mb-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-indigo-400">
              Material Preview
            </p>
            <h1 className="mt-1 text-2xl font-semibold text-white">
              {section.title}
            </h1>
            <p className="text-sm text-slate-400 mt-1">{section.description}</p>
          </div>
          <button
            onClick={handleBack}
            className="flex items-center gap-2 border border-white px-4 py-2 text-sm font-semibold text-white transition hover:bg-white hover:text-black cursor-pointer"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Back
          </button>
        </div>

        {/* Error/Upload Progress */}
        {error && (
          <div className="mb-4 bg-red-900/30 border border-red-500 px-4 py-3 text-red-300 flex justify-between items-center">
            <span>{error}</span>
            <button onClick={() => setError(null)} className="text-red-300 hover:text-red-100">✕</button>
          </div>
        )}

        {/* Upload Warnings */}
        {uploadWarnings.length > 0 && (
          <div className="mb-4 bg-amber-900/30 border border-amber-500 px-4 py-3 text-amber-200">
            <div className="flex justify-between items-start">
              <div>
                <p className="font-medium text-amber-300">File Processing Warning</p>
                {uploadWarnings.map((warning, index) => (
                  <div key={index} className="mt-2 text-sm">
                    {warning.fileName && (
                      <p className="font-medium">{warning.fileName}:</p>
                    )}
                    <p className="text-amber-200/90">{warning.message}</p>
                    <p className="text-amber-200/70 mt-1">
                      <span className="italic">{warning.suggestion}</span>
                    </p>
                  </div>
                ))}
              </div>
              <button 
                onClick={() => setUploadWarnings([])} 
                className="text-amber-300 hover:text-amber-100 ml-4"
              >
                ✕
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-hidden flex border border-slate-700">
        {/* File List Sidebar */}
        <div className="w-1/3 border-r border-slate-700 overflow-y-auto bg-black">
          <div className="p-4">
            <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-wide mb-3">
              Files ({section.files.length})
            </h3>
            {section.files.length === 0 ? (
              <p className="text-sm text-slate-500 italic">No files uploaded yet</p>
            ) : (
              <div className="space-y-2">
                {section.files.map((file) => (
                  <div
                    key={file.id}
                    className={`relative group transition ${
                      file.processing 
                        ? 'opacity-60 bg-slate-800 text-slate-400'
                        : selectedFile?.id === file.id
                        ? 'bg-indigo-600 text-white'
                        : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                    }`}
                  >
                    <button
                      onClick={() => !file.processing && setSelectedFile(file)}
                      disabled={file.processing}
                      className={`w-full text-left p-3 pr-12 ${
                        file.processing ? 'cursor-not-allowed' : 'cursor-pointer'
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium truncate">{file.name}</p>
                          <div className={`text-xs flex items-center gap-2 ${selectedFile?.id === file.id ? 'text-indigo-200' : 'text-slate-500'}`}>
                            <span>{file.size || 'Unknown size'}</span>
                            <span>-</span>
                            {file.processing ? (
                              <span className={`flex items-center gap-1 ${selectedFile?.id === file.id ? 'text-yellow-300' : 'text-yellow-500'}`}>
                                <div className="animate-spin h-3 w-3 border-2 border-yellow-500 border-t-transparent rounded-full" />
                                Processing
                              </span>
                            ) : file.materialId ? (
                              <span className={`${selectedFile?.id === file.id ? 'text-green-300' : 'text-green-500'}`}>Processed</span>
                            ) : (
                              <span className={`${selectedFile?.id === file.id ? 'text-amber-300' : 'text-amber-500'}`}>Not processed</span>
                            )}
                          </div>
                        </div>
                      </div>
                    </button>
                    
                    {/* Delete Button */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteFile(file.id);
                      }}
                      className={`absolute right-3 top-1/2 -translate-y-1/2 p-1.5 transition opacity-0 group-hover:opacity-100 cursor-pointer ${
                        selectedFile?.id === file.id
                          ? 'text-white hover:text-red-300'
                          : 'text-slate-400 hover:text-red-400'
                      }`}
                      title="Delete file"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Upload More Files */}
          <div className="p-4 border-t border-slate-700">
            {/* Drag and Drop Zone */}
            <div
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              className={`mb-3 border-2 border-dashed px-4 py-6 text-center transition ${
                isDragging 
                  ? 'border-indigo-500 bg-indigo-900/20' 
                  : 'border-slate-600 bg-slate-800/50 hover:border-slate-500'
              }`}
            >
              <svg 
                xmlns="http://www.w3.org/2000/svg" 
                className={`h-8 w-8 mx-auto mb-2 transition ${
                  isDragging ? 'text-indigo-400' : 'text-slate-500'
                }`} 
                fill="none" 
                viewBox="0 0 24 24" 
                stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
              <p className={`text-sm font-medium ${isDragging ? 'text-indigo-300' : 'text-slate-400'}`}>
                {isDragging ? 'Drop files here' : 'Drag and drop files here'}
              </p>
              <p className="text-xs text-slate-500 mt-1">
                PDF, DOCX, DOC, TXT, MD, TEX, MP3
              </p>
            </div>

            {/* Upload Button */}
            <label className="block">
              <input
                type="file"
                multiple
                accept=".pdf,.docx,.doc,.txt,.md,.tex,.mp3"
                onChange={handleFileUpload}
                className="hidden"
              />
              <span className="inline-flex w-full cursor-pointer items-center justify-center gap-2 bg-white border border-white px-4 py-3 text-sm font-semibold text-black transition hover:bg-black hover:text-white">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                Upload Files
              </span>
            </label>
          </div>
        </div>

        {/* File Preview Area */}
        <div className="flex-1 overflow-y-auto bg-black">
          {selectedFile ? (
            <div className="p-6 bg-black">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold text-white">{selectedFile.name}</h3>
                <button
                  onClick={() => {
                    handleDeleteFile(selectedFile.id);
                  }}
                  className="text-red-400 hover:text-red-300 text-sm flex items-center gap-1 cursor-pointer"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                  Delete
                </button>
              </div>
              
              <div className="flex gap-4 mb-4 text-sm text-slate-400">
                <span>Size: {selectedFile.size || 'Unknown'}</span>
                <span>Uploaded: {selectedFile.uploadDate}</span>
              </div>

              <div className="border border-slate-700 bg-black">
                <div className="px-4 py-2 border-b border-slate-700 bg-black">
                  <span className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
                    Extracted Text Content
                  </span>
                </div>
                <div className="p-4 max-h-[calc(100vh-300px)] overflow-y-auto bg-black">
                  {isLoadingContent ? (
                    <div className="flex items-center gap-2 text-slate-400">
                      <div className="animate-spin h-4 w-4 border-2 border-slate-400 border-t-transparent rounded-full" />
                      <span className="text-sm">Loading extracted content...</span>
                    </div>
                  ) : fileTextContent ? (
                    <div>
                      {isContentGarbled && (
                        <div className="mb-4 bg-amber-900/40 border border-amber-500 p-4 rounded">
                          <div>
                            <p className="font-semibold text-amber-300 mb-1">Garbled Text Detected</p>
                            <p className="text-sm text-amber-200/90 mb-2">
                              This PDF appears to use custom font encoding. The extracted text is not readable and search/quiz features will not work correctly.
                            </p>
                            <p className="text-sm text-amber-200/70">
                              <strong>Suggestion:</strong> Try finding a different version of this PDF with proper text encoding, or download from the original source (e.g., publisher&apos;s website).
                            </p>
                          </div>
                        </div>
                      )}
                      <pre className="text-sm text-slate-300 whitespace-pre-wrap font-mono">
                        {fileTextContent}
                      </pre>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <p className="text-sm text-slate-400">
                        {contentMessage || 'No text content available.'}
                      </p>
                      <div className="bg-amber-900/30 border border-amber-700 p-3">
                        <p className="text-sm text-amber-300 font-medium mb-1">How to fix:</p>
                        <p className="text-xs text-amber-200/80">
                          This file was uploaded before text extraction was enabled. 
                          Please <strong>delete this file</strong> and <strong>re-upload it</strong> to extract text from PDF and Word documents.
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="h-full flex items-center justify-center text-slate-500 bg-black">
              <div className="text-center">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12 mx-auto mb-3 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <p>Select a file to preview</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function PreviewPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
      </div>
    }>
      <PreviewContent />
    </Suspense>
  );
}
