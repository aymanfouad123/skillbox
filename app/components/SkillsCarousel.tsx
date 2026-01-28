"use client";

import { TOP_SKILLS } from "../data/skills";
import { SkillCard } from "./SkillCard";

export function SkillsCarousel() {
  // Duplicate skills for seamless infinite scroll
  const duplicatedSkills = [...TOP_SKILLS, ...TOP_SKILLS];

  return (
    <section className="mb-24">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-sm tracking-widest text-gray-400 uppercase">
          Top Skills
        </h2>
      </div>

      <div className="relative overflow-hidden">
        {/* Gradient fade edges */}
        <div className="absolute left-0 top-0 bottom-0 w-12 bg-gradient-to-r from-black to-transparent z-10 pointer-events-none" />
        <div className="absolute right-0 top-0 bottom-0 w-12 bg-gradient-to-l from-black to-transparent z-10 pointer-events-none" />

        <div className="flex gap-4 animate-carousel hover:[animation-play-state:paused]">
          {duplicatedSkills.map((skill, idx) => (
            <div key={`${skill.rank}-${idx}`} className="flex-shrink-0 w-64">
              <SkillCard skill={skill} />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
