"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { useData } from "@/app/context/DataContext";
import { practiceApi, type TopicAnalysis } from "@/lib/api";

export default function Home() {
  const { data: session } = useSession();
  const { folders, practiceOverview, isLoadingFolders, isLoadingOverview } = useData();
  const userId = session?.user?.id;
  
  const [topicAnalysis, setTopicAnalysis] = useState<TopicAnalysis | null>(null);
  const [isLoadingTopics, setIsLoadingTopics] = useState(false);

  // Load topic analysis for focus areas
  useEffect(() => {
    const loadTopicAnalysis = async () => {
      if (!userId) return;
      setIsLoadingTopics(true);
      try {
        const analysis = await practiceApi.getTopicAnalysis(userId);
        setTopicAnalysis(analysis);
      } catch (err) {
        console.error('Failed to load topic analysis:', err);
      } finally {
        setIsLoadingTopics(false);
      }
    };
    loadTopicAnalysis();
  }, [userId]);

  const isLoading = isLoadingFolders || isLoadingOverview || isLoadingTopics;

  // Calculate real stats
  const totalQuizzes = practiceOverview?.stats.totalQuizzes || 0;
  const totalFlashcards = practiceOverview?.stats.totalFlashcardSets || 0;
  const overallAccuracy = topicAnalysis?.summary.overallAccuracy;
  const totalMaterials = folders.reduce((acc, f) => acc + f.sections.length + f.subfolders.reduce((s, sf) => s + sf.sections.length, 0), 0);

  // Get recent quiz attempts for activity
  const recentAttempts = practiceOverview?.recentAttempts?.slice(0, 3) || [];

  // Get focus areas (weak topics)
  const focusAreas = topicAnalysis?.focusAreas?.slice(0, 3) || [];

  // Get mastered topics
  const masteredTopics = topicAnalysis?.topics?.filter(t => !t.needsWork && t.totalAttempts >= 3).slice(0, 5) || [];

  const quickLinks = [
    {
      title: "Course Material",
      description: "Upload and organize your study materials, PDFs, and notes.",
      href: "/course-material",
      count: totalMaterials,
      countLabel: "materials",
    },
    {
      title: "Generate Quiz",
      description: "Create quizzes and flashcards from your uploaded content.",
      href: "/practice?view=generate",
      count: totalQuizzes + totalFlashcards,
      countLabel: "practice sets",
    },
    {
      title: "Voice Companion",
      description: "Talk through concepts and get AI-powered explanations.",
      href: "/voice",
      count: null,
      countLabel: null,
    },
  ];

  return (
    <div className="space-y-12">
      {/* Hero Section with Real Stats */}
      <section className="overflow-hidden bg-gradient-to-br from-indigo-950 via-slate-900 to-slate-800 text-white shadow-xl ring-1 ring-white/10">
        <div className="grid gap-8 px-8 py-12 md:grid-cols-2 md:items-center md:px-12">
          <div className="space-y-6">
            <p className="inline-flex bg-white/10 px-4 py-2 text-sm font-medium uppercase tracking-wide text-indigo-300 ring-1 ring-white/20">
              Your Study Assistant
            </p>
            <div className="space-y-4">
              {isLoading ? (
                <>
                  <div className="h-10 bg-slate-700 animate-pulse w-3/4 mb-2" />
                  <div className="h-6 bg-slate-700 animate-pulse w-full" />
                  <div className="h-6 bg-slate-700 animate-pulse w-2/3" />
                </>
              ) : topicAnalysis && (topicAnalysis.focusAreas.length > 0 || masteredTopics.length > 0) ? (
                <>
                  <h1 className="text-3xl font-semibold leading-tight md:text-4xl">
                    {masteredTopics.length > 0 && focusAreas.length > 0 ? (
                      <>You&apos;re doing great on <span className="text-green-400">{masteredTopics.slice(0, 2).map(t => t.topic).join(' and ')}</span></>
                    ) : masteredTopics.length > 0 ? (
                      <>You&apos;ve mastered <span className="text-green-400">{masteredTopics.slice(0, 3).map(t => t.topic).join(', ')}</span></>
                    ) : (
                      <>Keep practicing to build your strengths</>
                    )}
                  </h1>
                  <p className="text-slate-300">
                    {focusAreas.length > 0 ? (
                      <>
                        Focus on improving: <span className="text-orange-400 font-medium">{focusAreas.slice(0, 3).map(t => t.topic).join(', ')}</span>.
                        {' '}Your overall accuracy is {overallAccuracy !== null && overallAccuracy !== undefined ? `${overallAccuracy}%` : 'not yet calculated'}.
                      </>
                    ) : (
                      <>
                        Great job! You&apos;re performing well across all topics. 
                        Keep practicing to maintain your {overallAccuracy !== null && overallAccuracy !== undefined ? `${overallAccuracy}% accuracy` : 'progress'}.
                      </>
                    )}
                  </p>
                </>
              ) : totalQuizzes > 0 ? (
                <>
                  <h1 className="text-3xl font-semibold leading-tight md:text-4xl">
                    You&apos;ve created {totalQuizzes} quiz{totalQuizzes !== 1 ? 'zes' : ''}
                  </h1>
                  <p className="text-slate-300">
                    Complete more quizzes to get personalized insights on your strengths and areas to improve.
                  </p>
                </>
              ) : (
                <>
                  <h1 className="text-3xl font-semibold leading-tight md:text-4xl">
                    Welcome to your study assistant
                  </h1>
                  <p className="text-slate-300">
                    Upload your course materials and generate quizzes to get AI-powered insights on what you know well and what needs more practice.
                  </p>
                </>
              )}
            </div>
            <div className="flex justify-center md:justify-start">
              <Link
                href="/practice"
                className="border border-white px-5 py-3 text-sm font-semibold text-white transition hover:bg-white hover:text-black cursor-pointer"
              >
                Start Practicing
              </Link>
            </div>
          </div>
          
          {/* Real Stats */}
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="bg-white/5 px-4 py-6 shadow-lg ring-1 ring-white/10">
              <p className="text-xs uppercase tracking-wide text-slate-400">
                Total Quizzes
              </p>
              <p className="mt-3 text-2xl font-semibold text-white">
                {isLoading ? (
                  <span className="inline-block w-8 h-6 bg-slate-700 animate-pulse" />
                ) : (
                  totalQuizzes
                )}
              </p>
              <p className="mt-2 text-xs text-slate-400">
                Practice sets created
              </p>
            </div>
            <div className="bg-white/5 px-4 py-6 shadow-lg ring-1 ring-white/10">
              <p className="text-xs uppercase tracking-wide text-slate-400">
                Flashcard Sets
              </p>
              <p className="mt-3 text-2xl font-semibold text-white">
                {isLoading ? (
                  <span className="inline-block w-8 h-6 bg-slate-700 animate-pulse" />
                ) : (
                  totalFlashcards
                )}
              </p>
              <p className="mt-2 text-xs text-slate-400">
                Cards for memorization
              </p>
            </div>
            <div className="bg-white/5 px-4 py-6 shadow-lg ring-1 ring-white/10">
              <p className="text-xs uppercase tracking-wide text-slate-400">
                Practice Accuracy
              </p>
              <p className="mt-3 text-2xl font-semibold text-white">
                {isLoading ? (
                  <span className="inline-block w-8 h-6 bg-slate-700 animate-pulse" />
                ) : overallAccuracy !== null && overallAccuracy !== undefined ? (
                  `${overallAccuracy}%`
                ) : (
                  "—"
                )}
              </p>
              <p className="mt-2 text-xs text-slate-400">
                Overall performance
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Quick Links with Real Counts */}
      <section className="grid gap-6 md:grid-cols-3">
        {quickLinks.map((link) => (
          <Link
            key={link.title}
            href={link.href}
            className="flex h-full flex-col justify-between border border-slate-800 bg-black p-6 shadow-sm transition hover:border-slate-700 cursor-pointer"
          >
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-wide text-indigo-400">
                  {link.title}
                </p>
                {link.count !== null && link.count > 0 && (
                  <span className="text-slate-400 text-xs font-medium">
                    {link.count} {link.countLabel}
                  </span>
                )}
              </div>
              <p className="text-base text-slate-300">{link.description}</p>
            </div>
            <span className="mt-6 text-sm font-semibold text-white">
              Open →
            </span>
          </Link>
        ))}
      </section>

      {/* Two Column Layout: Recent Activity & Focus Areas */}
      <section className="grid gap-8 md:grid-cols-[1.2fr_0.8fr]">
        {/* Recent Activity */}
        <div className="space-y-4 border border-slate-800 bg-black p-6 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                Recent Activity
              </p>
              <h2 className="text-xl font-semibold text-white">
                Your latest practice sessions
              </h2>
            </div>
            {recentAttempts.length > 0 && (
              <Link 
                href="/practice" 
                className="text-xs font-medium text-indigo-400 hover:text-indigo-300"
              >
                View all →
              </Link>
            )}
          </div>
          
          {isLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="flex items-center gap-4 border border-slate-800 px-4 py-3 animate-pulse">
                  <div className="w-12 h-12 bg-slate-700" />
                  <div className="flex-1 space-y-2">
                    <div className="h-4 bg-slate-700 w-3/4" />
                    <div className="h-3 bg-slate-700 w-1/2" />
                  </div>
                </div>
              ))}
            </div>
          ) : recentAttempts.length > 0 ? (
            <div className="space-y-3">
              {recentAttempts.map((attempt, index) => {
                const isGood = attempt.percentage >= 70;
                const isModerate = attempt.percentage >= 50 && attempt.percentage < 70;
                return (
                  <div
                    key={attempt.id || index}
                    className="flex items-center gap-4 border border-slate-800 px-4 py-3"
                  >
                    <div className={`w-12 h-12 flex items-center justify-center font-bold text-lg border ${
                      isGood ? 'text-green-400 border-green-600/50' :
                      isModerate ? 'text-yellow-400 border-yellow-600/50' :
                      'text-red-400 border-red-600/50'
                    }`}>
                      {attempt.percentage}%
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-white truncate">
                        {attempt.quiz_name || 'Practice Quiz'}
                      </p>
                      <p className="text-sm text-slate-400">
                        {attempt.score}/{attempt.total_questions} correct • {new Date(attempt.completed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      </p>
                    </div>
                    <Link
                      href="/practice"
                      className="text-slate-500 hover:text-white transition p-2"
                      title="Practice again"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                    </Link>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <div className="w-16 h-16 mb-4 flex items-center justify-center border border-slate-700">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                </svg>
              </div>
              <p className="text-slate-400 mb-2">No practice history yet</p>
              <p className="text-slate-500 text-sm mb-4">
                Generate your first quiz from your course materials
              </p>
              <Link
                href="/practice?view=generate"
                className="border border-white px-4 py-2 text-sm font-semibold text-white transition hover:bg-white hover:text-black cursor-pointer"
              >
                Start practicing
              </Link>
            </div>
          )}
          
          {recentAttempts.length > 0 && (
            <div className="flex items-center justify-between border border-slate-700 px-4 py-3 text-white">
              <div>
                <p className="text-sm font-semibold">Ready for more practice?</p>
                <p className="text-sm text-slate-400">
                  Generate new questions from your course materials.
                </p>
              </div>
              <Link
                href="/practice?view=generate"
                className="border border-white px-3 py-2 text-xs font-semibold text-white transition hover:bg-white hover:text-black cursor-pointer"
              >
                Generate Quiz
              </Link>
            </div>
          )}
        </div>

        {/* Focus Areas & Mastered Topics */}
        <div className="space-y-4 border border-slate-800 bg-black p-6 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                Performance Insights
              </p>
              <h3 className="text-lg font-semibold text-white">
                {focusAreas.length > 0 ? 'Topics to focus on' : 'Your progress'}
              </h3>
            </div>
            {topicAnalysis && (
              <span className="bg-slate-800 px-3 py-1 text-xs font-medium text-slate-300">
                {topicAnalysis.summary.totalTopics} topics tracked
              </span>
            )}
          </div>
          
          {isLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="border border-slate-700 px-3 py-3 animate-pulse">
                  <div className="h-4 bg-slate-700 w-3/4 mb-2" />
                  <div className="h-3 bg-slate-700 w-1/2" />
                </div>
              ))}
            </div>
          ) : focusAreas.length > 0 ? (
            <>
              <ul className="space-y-3 text-sm">
                {focusAreas.map((topic, index) => (
                  <li 
                    key={`${topic.topic}-${index}`}
                    className="flex items-center justify-between bg-orange-900/20 border border-orange-600/30 px-3 py-3"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-white font-medium truncate">{topic.topic}</p>
                      <p className="text-slate-500 text-xs">
                        {topic.correctCount}/{topic.totalAttempts} correct
                      </p>
                    </div>
                    <div className="text-orange-400 font-bold ml-3">
                      {topic.accuracy}%
                    </div>
                  </li>
                ))}
              </ul>
              <Link
                href="/practice?view=generate"
                className="inline-flex w-full items-center justify-center border border-white px-4 py-3 text-sm font-semibold text-white transition hover:bg-white hover:text-black cursor-pointer"
              >
                Practice weak topics
              </Link>
            </>
          ) : masteredTopics.length > 0 ? (
            <>
              <p className="text-slate-400 text-sm mb-3">Topics you&apos;ve mastered:</p>
              <div className="flex flex-wrap gap-2">
                {masteredTopics.map((topic, index) => (
                  <span 
                    key={`${topic.topic}-${index}`}
                    className="inline-flex items-center gap-1 bg-green-900/20 border border-green-600/30 px-2 py-1 text-xs text-green-300"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3 text-green-500" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                    {topic.topic}
                  </span>
                ))}
              </div>
              <Link
                href="/practice?view=generate"
                className="inline-flex w-full items-center justify-center border border-white px-4 py-3 text-sm font-semibold text-white transition hover:bg-white hover:text-black cursor-pointer mt-4"
              >
                Continue practicing
              </Link>
            </>
          ) : (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <div className="w-12 h-12 mb-3 flex items-center justify-center border border-slate-700">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
              </div>
              <p className="text-slate-400 text-sm mb-1">No topic data yet</p>
              <p className="text-slate-500 text-xs">
                Complete some quizzes to see insights
              </p>
            </div>
          )}
        </div>
      </section>

      {/* Materials Overview */}
      {folders.length > 0 && (
        <section className="border border-slate-800 bg-black p-6 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                Your Materials
              </p>
              <h3 className="text-lg font-semibold text-white">
                Uploaded course content
              </h3>
            </div>
            <Link 
              href="/course-material" 
              className="text-xs font-medium text-indigo-400 hover:text-indigo-300"
            >
              Manage materials →
            </Link>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {folders.slice(0, 3).map((folder) => (
              <Link
                key={folder.id}
                href="/course-material"
                className="flex items-center gap-4 border border-slate-800 bg-slate-800/30 p-4 hover:border-slate-700 transition"
              >
                <div 
                  className="w-10 h-10 flex items-center justify-center border border-indigo-500"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="#6366f1" viewBox="0 0 24 24">
                    <path d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z" />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-white font-medium truncate">{folder.name}</p>
                  <p className="text-slate-500 text-xs">
                    {folder.sections.length} material{folder.sections.length !== 1 ? 's' : ''}
                  </p>
                </div>
              </Link>
            ))}
          </div>
          {folders.length > 3 && (
            <p className="text-slate-500 text-sm mt-4 text-center">
              +{folders.length - 3} more folder{folders.length - 3 !== 1 ? 's' : ''}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
