"use client";

import { useState } from "react";
import { TOP_SKILLS } from "../data/skills";
import { SkillCard } from "./SkillCard";

const ITEMS_PER_PAGE = 3;
const CARD_WIDTH = 256; // w-64 = 16rem = 256px
const GAP = 16; // gap-4 = 1rem = 16px

interface SkillsCarouselProps {
  onBoot?: (path: string) => void;
}

export function SkillsCarousel({ onBoot }: SkillsCarouselProps) {
  const [startIndex, setStartIndex] = useState(0);

  const canGoBack = startIndex > 0;
  const canGoForward = startIndex + ITEMS_PER_PAGE < TOP_SKILLS.length;

  const goBack = () => {
    if (canGoBack) {
      setStartIndex((prev) => prev - 1);
    }
  };

  const goForward = () => {
    if (canGoForward) {
      setStartIndex((prev) => prev + 1);
    }
  };

  const translateX = -(startIndex * (CARD_WIDTH + GAP));

  return (
    <section className="mb-16">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-sm tracking-widest text-orange-400/80 uppercase">
          Top Skills
        </h2>
        {/* Navigation arrows - hidden on mobile (vertical scroll) */}
        <div className="hidden sm:flex items-center gap-2">
          <button
            onClick={goBack}
            disabled={!canGoBack}
            className="w-8 h-8 border border-white/20 flex items-center justify-center transition-colors enabled:hover:border-accent/60 enabled:hover:text-accent disabled:opacity-20"
          >
            ←
          </button>
          <button
            onClick={goForward}
            disabled={!canGoForward}
            className="w-8 h-8 border border-white/20 flex items-center justify-center transition-colors enabled:hover:border-accent/60 enabled:hover:text-accent disabled:opacity-20"
          >
            →
          </button>
        </div>
      </div>

      {/* Mobile: vertical scrollable list */}
      <div className="flex flex-col gap-4 sm:hidden max-h-[50vh] overflow-y-auto pr-1">
        {TOP_SKILLS.map((skill) => (
          <div key={skill.rank} className="w-full">
            <SkillCard skill={skill} onBoot={onBoot} />
          </div>
        ))}
      </div>

      {/* Desktop: horizontal carousel */}
      <div className="hidden sm:block overflow-hidden">
        <div
          className="flex gap-4 transition-transform duration-300 ease-out"
          style={{ transform: `translateX(${translateX}px)` }}
        >
          {TOP_SKILLS.map((skill) => (
            <div key={skill.rank} className="shrink-0 w-64">
              <SkillCard skill={skill} onBoot={onBoot} />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
