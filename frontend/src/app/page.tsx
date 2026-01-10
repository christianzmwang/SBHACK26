import Link from "next/link";

const stats = [
  { label: "Daily streak", value: "12 days" },
  { label: "Study time", value: "3h 20m" },
  { label: "Practice accuracy", value: "86%" },
];

const studyPlan = [
  {
    title: "Linear Algebra · Review",
    detail: "Watch lecture 5 summary, complete checkpoints 1-3.",
    time: "30 min",
  },
  {
    title: "Systems Design · Notes",
    detail: "Refine flashcards for CAP theorem and load balancers.",
    time: "25 min",
  },
  {
    title: "Algorithms · Practice",
    detail: "Two medium problems on graphs and BFS variants.",
    time: "35 min",
  },
];

  const quickLinks = [
    {
      title: "Course Material",
      description: "Structured outlines, summaries, and reading queues.",
      href: "/course-material",
    },
    {
      title: "Practice Center",
      description: "Timed drills, prompts, and quick recall checks.",
      href: "/practice",
    },
    {
      title: "Voice Companion",
      description: "Talk through concepts, explanations, and exam prep.",
      href: "/voice",
    },
    {
      title: "Session templates",
      description: "Focus timers, reflection prompts, and checklists.",
      href: "/course-material#templates",
    },
  ];

export default function Home() {
  return (
    <div className="space-y-12">
      <section className="overflow-hidden bg-gradient-to-br from-indigo-950 via-slate-900 to-slate-800 text-white shadow-xl ring-1 ring-white/10">
        <div className="grid gap-8 px-8 py-12 md:grid-cols-2 md:items-center md:px-12">
          <div className="space-y-6">
            <p className="inline-flex bg-white/10 px-4 py-2 text-sm font-medium uppercase tracking-wide text-indigo-300 ring-1 ring-white/20">
              Your Study Assistant
            </p>
            <div className="space-y-4">
              <h1 className="text-3xl font-semibold leading-tight md:text-4xl">
                Study smarter with focused plans, curated material, and guided
                practice.
              </h1>
              <p className="text-slate-300">
                Omnes keeps your courses organized, surfaces what to review
                next, and gives you fast practice loops to stay sharp before
                exams.
              </p>
            </div>
            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
              <div className="flex justify-center md:justify-start">
                <Link
                  href="/practice"
                  className="bg-white border border-white px-5 py-3 text-sm font-semibold text-black transition hover:bg-black hover:text-white cursor-pointer"
                >
                  Practice center
                </Link>
              </div>
              <div className="flex justify-end">
                <Link
                  href="/course-material"
                  className="border border-white px-5 py-3 text-sm font-semibold text-white transition hover:bg-white hover:text-black cursor-pointer"
                >
                  Review course material
                </Link>
              </div>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            {stats.map((stat) => (
              <div
                key={stat.label}
                className="bg-white/5 px-4 py-6 shadow-lg ring-1 ring-white/10"
              >
                <p className="text-xs uppercase tracking-wide text-slate-400">
                  {stat.label}
                </p>
                <p className="mt-3 text-2xl font-semibold text-white">{stat.value}</p>
                <p className="mt-2 text-xs text-slate-400">
                  Tracked across last 7 days
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="grid gap-6 md:grid-cols-3">
        {quickLinks.map((link) => (
          <Link
            key={link.title}
            href={link.href}
            className="flex h-full flex-col justify-between border border-slate-800 bg-black p-6 shadow-sm transition hover:border-slate-700 cursor-pointer"
          >
            <div className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-indigo-400">
                {link.title}
              </p>
              <p className="text-base text-slate-300">{link.description}</p>
            </div>
            <span className="mt-6 text-sm font-semibold text-white">
              Open
            </span>
          </Link>
        ))}
      </section>

      <section className="grid gap-8 md:grid-cols-[1.2fr_0.8fr]">
        <div className="space-y-4 border border-slate-800 bg-black p-6 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                Today&apos;s Plan
              </p>
              <h2 className="text-xl font-semibold text-white">
                Stay on track, one block at a time
              </h2>
            </div>
            <span className="bg-white px-4 py-2 text-xs font-semibold uppercase tracking-wide text-black">
              Focus
            </span>
          </div>
          <div className="space-y-3">
            {studyPlan.map((item) => (
              <div
                key={item.title}
                className="flex flex-col gap-1 border border-slate-800 bg-slate-800/50 px-4 py-3"
              >
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-white">
                    {item.title}
                  </p>
                  <span className="bg-slate-800 px-3 py-1 text-xs font-medium text-slate-300 ring-1 ring-slate-700">
                    {item.time}
                  </span>
                </div>
                <p className="text-sm text-slate-400">{item.detail}</p>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between bg-gradient-to-r from-slate-800 to-slate-700 px-4 py-3 text-white">
            <div>
              <p className="text-sm font-semibold">Need a new plan?</p>
              <p className="text-sm text-slate-300">
                View your stats and generate a personalized study plan.
              </p>
            </div>
            <Link
              href="/stats"
              className="bg-white border border-white px-3 py-2 text-xs font-semibold text-black transition hover:bg-black hover:text-white cursor-pointer"
            >
              Generate plan
            </Link>
          </div>
        </div>

        <div className="space-y-4 border border-slate-800 bg-black p-6 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                Quick Notes
              </p>
              <h3 className="text-lg font-semibold text-white">
                What Omnes suggests
              </h3>
            </div>
            <span className="bg-slate-800 px-3 py-1 text-xs font-medium text-slate-300">
              Updated
            </span>
          </div>
          <ul className="space-y-3 text-sm text-slate-300">
            <li className="bg-slate-800/50 px-3 py-2 ring-1 ring-slate-700">
              Refine flashcards with 3 spaced-repetition intervals for the week.
            </li>
            <li className="bg-slate-800/50 px-3 py-2 ring-1 ring-slate-700">
              Schedule one 10-minute active recall drill after each lecture.
            </li>
            <li className="bg-slate-800/50 px-3 py-2 ring-1 ring-slate-700">
              Summarize each session with 3 bullet takeaways to track progress.
            </li>
          </ul>
          <Link
            href="/practice"
            className="inline-flex w-full items-center justify-center bg-white border border-white px-4 py-3 text-sm font-semibold text-black transition hover:bg-black hover:text-white cursor-pointer"
          >
            Launch a practice session
          </Link>
        </div>
      </section>
    </div>
  );
}
