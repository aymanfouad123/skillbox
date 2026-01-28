import type { Skill } from "../data/skills";

interface SkillCardProps {
  skill: Skill;
  onBoot?: (path: string) => void;
}

export function SkillCard({ skill, onBoot }: SkillCardProps) {
  const skillPath = `skillbox.sh/${skill.author}/${skill.name}`;

  const handleClick = () => {
    onBoot?.(skillPath);
  };

  return (
    <div
      onClick={handleClick}
      className="border border-white/10 bg-black p-6 hover:bg-accent-muted hover:border-accent/30 cursor-pointer transition-all h-full group"
    >
      <div className="flex items-start justify-between mb-4">
        {/* Rank transforms to BOOT on hover */}
        <span className="text-xl font-bold text-white/20 group-hover:text-accent transition-colors">
          <span className="group-hover:hidden">#{skill.rank}</span>
          <span className="hidden group-hover:inline text-sm tracking-wider">[ BOOT ]</span>
        </span>
        <span className="text-[10px] bg-white/10 px-2 py-1 text-white-400 tracking-wider">
          {skill.installs}
        </span>
      </div>
      <h3 className="text-base font-bold mb-1 truncate">/{skill.name}</h3>
      <p className="text-xs text-gray-500 truncate">{skill.author}</p>
    </div>
  );
}
