"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import Link from "next/link";

interface StudyTask {
  id: string;
  type: "flashcards" | "quiz" | "review" | "practice";
  topic: string;
  title: string;
  description?: string;
  estimatedTime: string; // e.g., "15 mins", "1 hr"
  estimatedMinutes: number;
  questionCount?: number;
  cardCount?: number;
  priority: "high" | "medium" | "low";
  completed: boolean;
}

interface StudyPlan {
  id: string;
  name: string;
  createdAt: string;
  totalEstimatedTime: string;
  tasks: StudyTask[];
}

// Helper to get priority color
const getPriorityColor = (priority: string): { bg: string; border: string; text: string } => {
  switch (priority) {
    case "high":
      return { bg: "bg-red-900/20", border: "border-red-700", text: "text-red-400" };
    case "medium":
      return { bg: "bg-amber-900/20", border: "border-amber-700", text: "text-amber-400" };
    case "low":
      return { bg: "bg-green-900/20", border: "border-green-700", text: "text-green-400" };
    default:
      return { bg: "bg-slate-900/20", border: "border-slate-700", text: "text-slate-400" };
  }
};

// Helper to get task type icon
const getTaskIcon = (type: string) => {
  switch (type) {
    case "flashcards":
      return (
        <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
        </svg>
      );
    case "quiz":
      return (
        <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
        </svg>
      );
    case "review":
      return (
        <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
        </svg>
      );
    default:
      return (
        <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
      );
  }
};

// Helper to get task type color
const getTaskTypeColor = (type: string): string => {
  switch (type) {
    case "flashcards":
      return "text-purple-400";
    case "quiz":
      return "text-blue-400";
    case "review":
      return "text-emerald-400";
    default:
      return "text-indigo-400";
  }
};

function StudyPlanContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session } = useSession();
  const [isLoading, setIsLoading] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [studyPlan, setStudyPlan] = useState<StudyPlan | null>(null);
  const [error, setError] = useState<string | null>(null);

  const folderId = searchParams.get("folderId");
  const folderName = searchParams.get("folderName");
  const userId = session?.user?.id;

  useEffect(() => {
    if (userId) {
      generateStudyPlan();
    }
  }, [userId, folderId]);

  const generateStudyPlan = async () => {
    try {
      setIsGenerating(true);
      setIsLoading(true);
      
      // Fetch study plan from backend
      const url = folderId 
        ? `/api/practice/study-plan?userId=${userId}&folderId=${folderId}`
        : `/api/practice/study-plan?userId=${userId}`;
      
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error("Failed to generate study plan");
      }
      const data = await response.json();
      setStudyPlan(data.studyPlan);
    } catch (err) {
      console.error("Failed to generate study plan:", err);
      setError("Failed to generate study plan");
      // Use mock data for now if backend isn't ready
      setStudyPlan({
        id: "plan-1",
        name: folderName ? `${folderName} Study Plan` : "Personalized Study Plan",
        createdAt: new Date().toISOString(),
        totalEstimatedTime: "2 hrs 15 mins",
        tasks: [
          {
            id: "task-1",
            type: "flashcards",
            topic: "Statistics",
            title: "Review Statistics by Flashcards",
            description: "Focus on hypothesis testing and confidence intervals",
            estimatedTime: "20 mins",
            estimatedMinutes: 20,
            cardCount: 15,
            priority: "high",
            completed: false,
          },
          {
            id: "task-2",
            type: "quiz",
            topic: "Probability",
            title: "Take a 10 question quiz",
            description: "Bayes' theorem and conditional probability",
            estimatedTime: "25 mins",
            estimatedMinutes: 25,
            questionCount: 10,
            priority: "high",
            completed: false,
          },
          {
            id: "task-3",
            type: "review",
            topic: "Calculus",
            title: "Review Calculus concepts",
            description: "Integration techniques and applications",
            estimatedTime: "30 mins",
            estimatedMinutes: 30,
            priority: "medium",
            completed: false,
          },
          {
            id: "task-4",
            type: "flashcards",
            topic: "Calculus",
            title: "Review Calculus by Flashcards",
            description: "Derivative rules and limit theorems",
            estimatedTime: "15 mins",
            estimatedMinutes: 15,
            cardCount: 12,
            priority: "medium",
            completed: false,
          },
          {
            id: "task-5",
            type: "quiz",
            topic: "Linear Algebra",
            title: "Take a 5 question quiz",
            description: "Matrix operations refresher",
            estimatedTime: "15 mins",
            estimatedMinutes: 15,
            questionCount: 5,
            priority: "low",
            completed: false,
          },
          {
            id: "task-6",
            type: "practice",
            topic: "Discrete Math",
            title: "Practice Discrete Math problems",
            description: "Graph theory and combinatorics",
            estimatedTime: "30 mins",
            estimatedMinutes: 30,
            priority: "low",
            completed: false,
          },
        ],
      });
      setError(null); // Clear error since we're using mock data
    } finally {
      setIsLoading(false);
      setIsGenerating(false);
    }
  };

  const handleBack = () => {
    if (folderId) {
      router.push(`/stats?folderId=${folderId}&folderName=${encodeURIComponent(folderName || "")}`);
    } else {
      router.push("/stats");
    }
  };

  const handleToggleComplete = (taskId: string) => {
    if (!studyPlan) return;
    setStudyPlan({
      ...studyPlan,
      tasks: studyPlan.tasks.map(task =>
        task.id === taskId ? { ...task, completed: !task.completed } : task
      ),
    });
  };

  const handleStartTask = (task: StudyTask) => {
    // Navigate to appropriate practice page based on task type
    if (task.type === "quiz") {
      router.push(`/practice?action=generateQuiz&topic=${encodeURIComponent(task.topic)}&count=${task.questionCount || 10}`);
    } else if (task.type === "flashcards") {
      router.push(`/practice?action=generateFlashcards&topic=${encodeURIComponent(task.topic)}&count=${task.cardCount || 10}`);
    } else {
      router.push("/practice");
    }
  };

  // Calculate progress
  const completedTasks = studyPlan?.tasks.filter(t => t.completed).length || 0;
  const totalTasks = studyPlan?.tasks.length || 0;
  const progressPercent = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
  
  const completedMinutes = studyPlan?.tasks.filter(t => t.completed).reduce((acc, t) => acc + t.estimatedMinutes, 0) || 0;
  const totalMinutes = studyPlan?.tasks.reduce((acc, t) => acc + t.estimatedMinutes, 0) || 0;

  const formatTime = (minutes: number): string => {
    if (minutes < 60) return `${minutes} mins`;
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return mins > 0 ? `${hours} hr ${mins} mins` : `${hours} hr`;
  };

  if (isLoading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin h-8 w-8 border-2 border-indigo-400 border-t-transparent rounded-full mx-auto mb-4" />
          <p className="text-slate-400">
            {isGenerating ? "Generating your personalized study plan..." : "Loading study plan..."}
          </p>
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
            Personalized Plan
          </p>
          <h1 className="mt-1 text-2xl font-semibold text-white">
            {studyPlan?.name || "Your Study Plan"}
          </h1>
          <p className="mt-2 text-slate-400">
            A tailored study plan based on your performance in weaker topics
          </p>
        </div>
        <div className="flex gap-3">
          <button
            onClick={generateStudyPlan}
            disabled={isGenerating}
            className="flex items-center gap-2 border border-slate-600 px-4 py-2 text-sm font-semibold text-slate-300 transition hover:border-white hover:text-white cursor-pointer disabled:opacity-50"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className={`h-4 w-4 ${isGenerating ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Regenerate
          </button>
          <button
            onClick={handleBack}
            className="flex items-center gap-2 border border-white px-4 py-2 text-sm font-semibold text-white transition hover:bg-white hover:text-black cursor-pointer"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Back to Stats
          </button>
        </div>
      </div>

      {/* Progress Overview */}
      <div className="mb-8 bg-gradient-to-r from-indigo-950 via-slate-900 to-slate-800 border border-slate-700 p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold text-white">Today&apos;s Progress</h2>
            <p className="text-slate-400 text-sm mt-1">
              {completedTasks} of {totalTasks} tasks completed
            </p>
          </div>
          <div className="text-right">
            <p className="text-3xl font-bold text-white">{progressPercent}%</p>
            <p className="text-slate-400 text-sm">
              {formatTime(completedMinutes)} / {formatTime(totalMinutes)}
            </p>
          </div>
        </div>
        <div className="h-3 bg-slate-800 rounded-full overflow-hidden">
          <div 
            className="h-full bg-gradient-to-r from-indigo-500 to-purple-500 transition-all duration-500 rounded-full"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      </div>

      {/* Summary Stats */}
      <div className="grid gap-4 md:grid-cols-4 mb-8">
        <div className="border border-slate-800 bg-black p-4 text-center">
          <p className="text-2xl font-bold text-white">{studyPlan?.tasks.filter(t => t.type === "quiz").length || 0}</p>
          <p className="text-xs text-slate-500 uppercase tracking-wide mt-1">Quizzes</p>
        </div>
        <div className="border border-slate-800 bg-black p-4 text-center">
          <p className="text-2xl font-bold text-white">{studyPlan?.tasks.filter(t => t.type === "flashcards").length || 0}</p>
          <p className="text-xs text-slate-500 uppercase tracking-wide mt-1">Flashcard Sets</p>
        </div>
        <div className="border border-slate-800 bg-black p-4 text-center">
          <p className="text-2xl font-bold text-white">{studyPlan?.tasks.filter(t => t.priority === "high").length || 0}</p>
          <p className="text-xs text-slate-500 uppercase tracking-wide mt-1">High Priority</p>
        </div>
        <div className="border border-slate-800 bg-black p-4 text-center">
          <p className="text-2xl font-bold text-white">{formatTime(totalMinutes - completedMinutes)}</p>
          <p className="text-xs text-slate-500 uppercase tracking-wide mt-1">Time Remaining</p>
        </div>
      </div>

      {/* Task List */}
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">Study Tasks</h2>
        <div className="flex gap-2 text-sm">
          <span className="text-slate-500">Sort by priority</span>
        </div>
      </div>

      {!studyPlan || studyPlan.tasks.length === 0 ? (
        <div className="border border-dashed border-slate-700 bg-black p-12 text-center">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12 text-slate-600 mx-auto mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
          </svg>
          <p className="text-slate-400 mb-2">No study tasks generated</p>
          <p className="text-slate-500 text-sm">
            Complete some quizzes first to generate a personalized study plan
          </p>
          <Link
            href="/practice"
            className="mt-4 inline-block bg-white px-4 py-2 text-sm font-semibold text-black hover:bg-slate-200 transition cursor-pointer"
          >
            Go to Practice
          </Link>
        </div>
      ) : (
        <div className="space-y-4">
          {studyPlan.tasks
            .sort((a, b) => {
              const priorityOrder = { high: 0, medium: 1, low: 2 };
              return priorityOrder[a.priority] - priorityOrder[b.priority];
            })
            .map((task, index) => {
              const priorityColors = getPriorityColor(task.priority);
              
              return (
                <div
                  key={task.id}
                  className={`border border-slate-800 bg-black p-5 transition hover:border-slate-600 ${
                    task.completed ? "opacity-60" : ""
                  }`}
                >
                  <div className="flex items-start gap-4">
                    {/* Checkbox */}
                    <button
                      onClick={() => handleToggleComplete(task.id)}
                      className={`flex-shrink-0 w-6 h-6 mt-1 border-2 rounded flex items-center justify-center transition cursor-pointer ${
                        task.completed
                          ? "bg-green-600 border-green-600"
                          : "border-slate-600 hover:border-slate-400"
                      }`}
                    >
                      {task.completed && (
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-white" viewBox="0 0 20 20" fill="currentColor">
                          <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                        </svg>
                      )}
                    </button>

                    {/* Task Icon */}
                    <div className={`flex-shrink-0 ${getTaskTypeColor(task.type)}`}>
                      {getTaskIcon(task.type)}
                    </div>

                    {/* Task Content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <h3 className={`text-lg font-semibold ${task.completed ? "text-slate-500 line-through" : "text-white"}`}>
                            {task.title}
                          </h3>
                          {task.description && (
                            <p className="text-sm text-slate-500 mt-0.5">{task.description}</p>
                          )}
                        </div>
                        
                        {/* Priority Badge */}
                        <span className={`flex-shrink-0 px-2 py-1 text-xs font-medium uppercase tracking-wide ${priorityColors.bg} ${priorityColors.border} border ${priorityColors.text}`}>
                          {task.priority}
                        </span>
                      </div>

                      {/* Task Meta */}
                      <div className="mt-3 flex items-center gap-4 text-sm text-slate-500">
                        <span className="flex items-center gap-1.5">
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                          {task.estimatedTime}
                        </span>
                        <span className="text-slate-700">•</span>
                        <span className="text-indigo-400">{task.topic}</span>
                        {task.questionCount && (
                          <>
                            <span className="text-slate-700">•</span>
                            <span>{task.questionCount} questions</span>
                          </>
                        )}
                        {task.cardCount && (
                          <>
                            <span className="text-slate-700">•</span>
                            <span>{task.cardCount} cards</span>
                          </>
                        )}
                      </div>

                      {/* Start Button */}
                      {!task.completed && (
                        <button
                          onClick={() => handleStartTask(task)}
                          className="mt-4 inline-flex items-center gap-2 bg-white border border-white px-4 py-2 text-sm font-semibold text-black transition hover:bg-black hover:text-white cursor-pointer"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                          Start {task.type === "quiz" ? "Quiz" : task.type === "flashcards" ? "Flashcards" : "Review"}
                        </button>
                      )}
                    </div>

                    {/* Task Number */}
                    <div className="flex-shrink-0 w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center text-sm font-medium text-slate-400">
                      {index + 1}
                    </div>
                  </div>
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}

export default function StudyPlanPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500" />
      </div>
    }>
      <StudyPlanContent />
    </Suspense>
  );
}
