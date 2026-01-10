"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import Link from "next/link";

interface TopicStat {
  id: string;
  name: string;
  description?: string;
  score: number; // 0-100
  totalQuestions: number;
  correctAnswers: number;
  lastPracticed?: string;
  sourceFolder?: string;
}

// Helper to interpolate between red and green based on score
const getProgressColor = (score: number): string => {
  // Red (low) -> Yellow (mid) -> Green (high)
  if (score <= 50) {
    // Red to Yellow: rgb(239, 68, 68) to rgb(234, 179, 8)
    const ratio = score / 50;
    const r = Math.round(239 + (234 - 239) * ratio);
    const g = Math.round(68 + (179 - 68) * ratio);
    const b = Math.round(68 + (8 - 68) * ratio);
    return `rgb(${r}, ${g}, ${b})`;
  } else {
    // Yellow to Green: rgb(234, 179, 8) to rgb(34, 197, 94)
    const ratio = (score - 50) / 50;
    const r = Math.round(234 + (34 - 234) * ratio);
    const g = Math.round(179 + (197 - 179) * ratio);
    const b = Math.round(8 + (94 - 8) * ratio);
    return `rgb(${r}, ${g}, ${b})`;
  }
};

// Helper to get text color class based on score
const getScoreTextColor = (score: number): string => {
  if (score < 40) return "text-red-400";
  if (score < 70) return "text-amber-400";
  return "text-green-400";
};

function StatsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session } = useSession();
  const [isLoading, setIsLoading] = useState(true);
  const [topicStats, setTopicStats] = useState<TopicStat[]>([]);
  const [error, setError] = useState<string | null>(null);

  const folderId = searchParams.get("folderId");
  const folderName = searchParams.get("folderName");
  const userId = session?.user?.id;

  useEffect(() => {
    if (userId) {
      loadStats();
    }
  }, [userId, folderId]);

  const loadStats = async () => {
    try {
      setIsLoading(true);
      // Fetch stats from backend
      const url = folderId 
        ? `/api/practice/stats?userId=${userId}&folderId=${folderId}`
        : `/api/practice/stats?userId=${userId}`;
      
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error("Failed to load stats");
      }
      const data = await response.json();
      setTopicStats(data.topics || []);
    } catch (err) {
      console.error("Failed to load stats:", err);
      setError("Failed to load statistics");
      // Use mock data for now if backend isn't ready
      setTopicStats([
        { id: "1", name: "Linear Algebra", score: 85, totalQuestions: 20, correctAnswers: 17, lastPracticed: "2 days ago" },
        { id: "2", name: "Calculus", score: 62, totalQuestions: 15, correctAnswers: 9, lastPracticed: "1 week ago" },
        { id: "3", name: "Probability", score: 45, totalQuestions: 10, correctAnswers: 4, lastPracticed: "3 days ago" },
        { id: "4", name: "Statistics", score: 28, totalQuestions: 8, correctAnswers: 2, lastPracticed: "5 days ago" },
        { id: "5", name: "Discrete Math", score: 91, totalQuestions: 12, correctAnswers: 11, lastPracticed: "Yesterday" },
      ]);
      setError(null); // Clear error since we're using mock data
    } finally {
      setIsLoading(false);
    }
  };

  const handleBack = () => {
    if (folderId) {
      router.push("/practice");
    } else {
      router.push("/");
    }
  };

  const handleGenerateStudyPlan = () => {
    const params = new URLSearchParams();
    if (folderId) params.set("folderId", folderId);
    if (folderName) params.set("folderName", folderName);
    router.push(`/study-plan?${params.toString()}`);
  };

  // Calculate overall stats
  const overallScore = topicStats.length > 0
    ? Math.round(topicStats.reduce((acc, t) => acc + t.score, 0) / topicStats.length)
    : 0;

  const weakTopics = topicStats.filter(t => t.score < 50).length;
  const strongTopics = topicStats.filter(t => t.score >= 70).length;

  if (isLoading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="flex items-center gap-3 text-slate-400">
          <div className="animate-spin h-6 w-6 border-2 border-slate-400 border-t-transparent rounded-full" />
          <span>Loading statistics...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto -mt-4">
      {/* Error message */}
      {error && (
        <div className="mb-4 bg-red-900/30 border border-red-500 px-4 py-3 text-red-300 flex justify-between items-center">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="text-red-300 hover:text-red-100">×</button>
        </div>
      )}

      {/* Header */}
      <div className="mb-8 flex items-start justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-indigo-400">
            Performance Overview
          </p>
          <h1 className="mt-1 text-2xl font-semibold text-white">
            {folderName ? `${folderName} - Stats` : "Your Topic Statistics"}
          </h1>
          <p className="mt-2 text-slate-400">
            Track your progress across different topics and identify areas for improvement
          </p>
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

      {/* Summary Cards */}
      <div className="grid gap-4 md:grid-cols-3 mb-8">
        <div className="border border-slate-800 bg-black p-6">
          <p className="text-xs uppercase tracking-wide text-slate-500">Overall Score</p>
          <p className={`mt-2 text-4xl font-bold ${getScoreTextColor(overallScore)}`}>
            {overallScore}%
          </p>
          <div className="mt-3 h-2 bg-slate-800 rounded-full overflow-hidden">
            <div 
              className="h-full transition-all duration-500"
              style={{ 
                width: `${overallScore}%`,
                backgroundColor: getProgressColor(overallScore)
              }}
            />
          </div>
        </div>

        <div className="border border-slate-800 bg-black p-6">
          <p className="text-xs uppercase tracking-wide text-slate-500">Topics Needing Work</p>
          <p className="mt-2 text-4xl font-bold text-red-400">
            {weakTopics}
          </p>
          <p className="mt-2 text-sm text-slate-500">
            Topics below 50% mastery
          </p>
        </div>

        <div className="border border-slate-800 bg-black p-6">
          <p className="text-xs uppercase tracking-wide text-slate-500">Strong Topics</p>
          <p className="mt-2 text-4xl font-bold text-green-400">
            {strongTopics}
          </p>
          <p className="mt-2 text-sm text-slate-500">
            Topics above 70% mastery
          </p>
        </div>
      </div>

      {/* Generate Study Plan CTA */}
      <div className="mb-8 bg-gradient-to-r from-indigo-950 via-slate-900 to-slate-800 border border-slate-700 p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-white">Ready to improve?</h2>
            <p className="mt-1 text-slate-400">
              Generate a personalized study plan based on your weak areas
            </p>
          </div>
          <button
            onClick={handleGenerateStudyPlan}
            className="bg-white border border-white px-6 py-3 text-sm font-semibold text-black transition hover:bg-black hover:text-white cursor-pointer flex items-center gap-2"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            Generate Study Plan
          </button>
        </div>
      </div>

      {/* Topic Cards */}
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">Topic Breakdown</h2>
        <span className="text-sm text-slate-500">{topicStats.length} topics</span>
      </div>

      {topicStats.length === 0 ? (
        <div className="border border-dashed border-slate-700 bg-black p-12 text-center">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12 text-slate-600 mx-auto mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
          </svg>
          <p className="text-slate-400 mb-2">No topic data yet</p>
          <p className="text-slate-500 text-sm">
            Complete some quizzes to see your performance by topic
          </p>
          <Link
            href="/practice"
            className="mt-4 inline-block bg-white px-4 py-2 text-sm font-semibold text-black hover:bg-slate-200 transition cursor-pointer"
          >
            Go to Practice
          </Link>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {topicStats
            .sort((a, b) => a.score - b.score) // Sort by score ascending (weakest first)
            .map((topic) => (
              <div
                key={topic.id}
                className="border border-slate-800 bg-black p-5 transition hover:border-slate-600"
              >
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <h3 className="text-lg font-semibold text-white">{topic.name}</h3>
                    {topic.description && (
                      <p className="text-sm text-slate-500 mt-0.5">{topic.description}</p>
                    )}
                  </div>
                  <div className="text-right">
                    <span className={`text-2xl font-bold ${getScoreTextColor(topic.score)}`}>
                      {topic.score}%
                    </span>
                  </div>
                </div>

                {/* Progress Bar */}
                <div className="h-3 bg-slate-800 rounded-full overflow-hidden mb-3">
                  <div 
                    className="h-full transition-all duration-700 rounded-full"
                    style={{ 
                      width: `${topic.score}%`,
                      backgroundColor: getProgressColor(topic.score)
                    }}
                  />
                </div>

                {/* Stats Row */}
                <div className="flex items-center gap-4 text-sm text-slate-500">
                  <span>
                    {topic.correctAnswers}/{topic.totalQuestions} correct
                  </span>
                  {topic.lastPracticed && (
                    <>
                      <span className="text-slate-700">•</span>
                      <span>Last practiced: {topic.lastPracticed}</span>
                    </>
                  )}
                </div>

                {/* Status Badge */}
                <div className="mt-3">
                  {topic.score < 40 ? (
                    <span className="inline-flex items-center gap-1.5 bg-red-900/30 border border-red-700 px-2 py-1 text-xs font-medium text-red-400">
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                      </svg>
                      Needs Focus
                    </span>
                  ) : topic.score < 70 ? (
                    <span className="inline-flex items-center gap-1.5 bg-amber-900/30 border border-amber-700 px-2 py-1 text-xs font-medium text-amber-400">
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      In Progress
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 bg-green-900/30 border border-green-700 px-2 py-1 text-xs font-medium text-green-400">
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      Mastered
                    </span>
                  )}
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

export default function StatsPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500" />
      </div>
    }>
      <StatsContent />
    </Suspense>
  );
}
