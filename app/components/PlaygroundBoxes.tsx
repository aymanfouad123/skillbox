"use client";

import { useState, useEffect } from "react";

interface Playground {
  id: string;
  title: string;
  repo: string;
  description: string;
}

const playgrounds: Playground[] = [
  {
    id: "commerce",
    title: "Commerce",
    repo: "https://github.com/vercel/commerce",
    description: "Next.js e-commerce template",
  },
  {
    id: "chat",
    title: "Chat",
    repo: "https://github.com/vercel/ai-chatbot",
    description: "AI SDK chatbot starter",
  },
  {
    id: "platforms",
    title: "Platforms",
    repo: "https://github.com/vercel/platforms",
    description: "Multi-tenant app template",
  },
];

export function PlaygroundBoxes() {
  const [latched, setLatched] = useState<string | null>(null);

  // Persist latched state to session
  useEffect(() => {
    const stored = sessionStorage.getItem("skillbox-playground");
    if (stored) setLatched(stored);
  }, []);

  const handleLatch = (id: string) => {
    if (latched === id) {
      // Unlatch if clicking the same one
      setLatched(null);
      sessionStorage.removeItem("skillbox-playground");
    } else {
      setLatched(id);
      sessionStorage.setItem("skillbox-playground", id);
    }
  };

  return (
    <section className="mb-24">
      <p className="text-gray-400 mb-2 text-sm tracking-widest uppercase">
        Try Skills in Production
      </p>
      <p className="text-gray-500 text-xs mb-6">
        Test these skills in a real Vercel production environment.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {playgrounds.map((pg) => {
          const isLatched = latched === pg.id;
          return (
            <div
              key={pg.id}
              className={`
                group relative border p-6 transition-all duration-200 cursor-pointer
                ${
                  isLatched
                    ? "border-accent bg-accent-muted"
                    : "border-white/10 bg-black hover:border-white/30 hover:bg-white/5"
                }
              `}
              onClick={() => handleLatch(pg.id)}
            >
              <div className="flex items-start justify-between">
                <h3
                  className={`text-lg font-bold mb-2 transition-colors ${
                    isLatched ? "text-accent" : "text-white group-hover:text-white"
                  }`}
                >
                  {pg.title}
                </h3>

                {/* Arrow link to repo */}
                <a
                  href={pg.repo}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className={`
                    p-1 -m-1 transition-all
                    ${
                      isLatched
                        ? "text-accent hover:text-accent/80"
                        : "text-gray-600 hover:text-white"
                    }
                  `}
                  aria-label={`View ${pg.title} repository`}
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 16 16"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                    className="transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
                  >
                    <path
                      d="M4.5 11.5L11.5 4.5M11.5 4.5H6M11.5 4.5V10"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </a>
              </div>

              <p className="text-xs text-gray-500 mb-4">{pg.description}</p>

              <div
                className={`flex items-center gap-2 text-[10px] tracking-wider transition-opacity ${
                  isLatched
                    ? "text-accent/70"
                    : "text-gray-600 group-hover:text-gray-400"
                }`}
              >
                {isLatched && (
                  <span className="w-1.5 h-1.5 bg-accent rounded-full animate-pulse" />
                )}
                {isLatched ? "LATCHED" : "SELECT TO LATCH"}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
