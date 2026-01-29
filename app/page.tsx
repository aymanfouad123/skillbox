"use client";

import { useState, useRef } from "react";
import { Github, Star } from "lucide-react";
import { SkillsCarousel } from "./components/SkillsCarousel";
import { PlaygroundBoxes } from "./components/PlaygroundBoxes";

export default function Home() {
  const [searchValue, setSearchValue] = useState("");
  const [isBooting, setIsBooting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleBoot = (path: string) => {
    setSearchValue(path);
    setIsBooting(true);
    inputRef.current?.focus();

    // Reset booting state after animation
    setTimeout(() => {
      setIsBooting(false);
    }, 1500);
  };

  return (
    <main className="min-h-screen bg-black text-white font-mono selection:bg-accent selection:text-black">
      {/* Subtle background gradient */}
      <div className="fixed inset-0 bg-[radial-gradient(circle_at_center,var(--tw-gradient-stops))] from-white/5 via-transparent to-transparent pointer-events-none" />

      <div className="max-w-4xl mx-auto pt-16 px-6 relative z-10">
        {/* Logo/Brand */}
        <div className="flex items-center justify-between mb-12">
          <div className="flex items-center gap-4">
            <div className="w-8 h-8 border border-white flex items-center justify-center">
              <div className="w-4 h-4 bg-accent animate-pulse" />
            </div>
            <h1 className="text-2xl font-bold tracking-tighter">SKILLBOX.SH</h1>
          </div>
          <a
            href="https://github.com/aymanfouad123/skillbox"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 px-3 py-1.5 border border-white/20 hover:border-yellow-500/50 hover:bg-yellow-500/10 transition-all text-sm text-gray-400 hover:text-yellow-500"
          >
            <Github className="w-4 h-4" />
            Star on GitHub
          </a>
        </div>

        {/* The Action Hook */}
        <div className="mb-12">
          <p className="text-orange-400/80 mb-4 text-sm tracking-widest uppercase">
            Tryout Agent Skills
          </p>
          <div
            className={`
              group relative border p-4 transition-all duration-300
              ${isBooting ? "border-accent bg-accent-muted" : "border-white/20 hover:border-accent/50"}
            `}
          >
            <span
              className={`mr-2 transition-colors ${isBooting ? "text-accent" : "text-white/40"}`}
            >
              $
            </span>
            <input
              ref={inputRef}
              value={searchValue}
              onChange={(e) => setSearchValue(e.target.value)}
              className="bg-transparent outline-none w-full max-w-lg text-lg"
              placeholder="skillbox.sh/softaworks/agent-toolkit/mermaid-diagrams"
              autoFocus
            />
            <div
              className={`
                absolute right-4 top-1/2 -translate-y-1/2 text-[10px] tracking-wider transition-all
                ${isBooting ? "text-accent animate-pulse block" : "text-gray-500 hidden group-hover:block"}
              `}
            >
              {isBooting ? "BOOTING..." : "PRESS ENTER TO BOOT"}
            </div>
          </div>
        </div>

        {/* Playground Boxes - Try skills in real Vercel production */}
        <PlaygroundBoxes />

        {/* Top Skills Carousel */}
        <SkillsCarousel onBoot={handleBoot} />
      </div>
    </main>
  );
}
