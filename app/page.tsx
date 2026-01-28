import { SkillsCarousel } from "./components/SkillsCarousel";

export default function Home() {
  return (
    <main className="min-h-screen bg-black text-white font-mono selection:bg-accent selection:text-black">
      {/* Subtle background gradient */}
      <div className="fixed inset-0 bg-[radial-gradient(circle_at_center,var(--tw-gradient-stops))] from-white/5 via-transparent to-transparent pointer-events-none" />

      <div className="max-w-4xl mx-auto pt-32 px-6 relative z-10">
        {/* Logo/Brand */}
        <div className="flex items-center gap-4 mb-12">
          <div className="w-8 h-8 border border-white flex items-center justify-center">
            <div className="w-4 h-4 bg-accent animate-pulse" />
          </div>
          <h1 className="text-2xl font-bold tracking-tighter">SKILLBOX.SH</h1>
        </div>

        {/* The Action Hook */}
        <div className="mb-24">
          <p className="text-gray-400 mb-4 text-sm tracking-widest uppercase">
            Tryout Agent Skills
          </p>
          <div className="group relative border border-white/20 p-4 hover:border-accent/50 transition-colors">
            <span className="text-white/40 mr-2">$</span>
            <input
              className="bg-transparent outline-none w-full max-w-lg text-lg"
              placeholder="skillbox.sh/softaworks/agent-toolkit/mermaid-diagrams"
              autoFocus
            />
            <div className="absolute right-4 top-1/2 -translate-y-1/2 text-[10px] text-gray-500 hidden group-hover:block">
              PRESS ENTER TO BOOT
            </div>
          </div>
        </div>

        {/* Top Skills Carousel */}
        <SkillsCarousel />
      </div>
    </main>
  );
}
