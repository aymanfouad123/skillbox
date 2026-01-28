import type { Skill } from "../data/skills";

interface SkillCardProps {
  skill: Skill;
}

export function SkillCard({ skill }: SkillCardProps) {
  return (
    <div className="border border-white/10 bg-black p-6 hover:bg-accent-muted hover:border-accent/30 cursor-pointer transition-all h-full group">
      <div className="flex items-start justify-between mb-4">
        <span className="text-3xl font-bold text-white/20 group-hover:text-accent/40 transition-colors">#{skill.rank}</span>
        <span className="text-[10px] bg-white/10 px-2 py-1 text-white-400 tracking-wider">
          {skill.installs}
        </span>
      </div>
      <h3 className="text-base font-bold mb-1 truncate">/{skill.name}</h3>
      <p className="text-xs text-gray-500 truncate">{skill.author}</p>
    </div>
  );
}
