"use client";

import { useState } from "react";
import { SandboxState, PLAYGROUNDS, Playground } from "../data/skills";

interface SandboxPageProps {
  owner: string;
  repo: string;
  skill?: string;
}

export function SandboxPage({
  owner,
  repo,
  skill: skillFromUrl,
}: SandboxPageProps) {
  const [sandboxState, setSandboxState] = useState<SandboxState>({
    status: "idle",
  });

  // Local state for skill input when not provided in URL
  const [skillInput, setSkillInput] = useState("");

  // Selected playground repo to clone
  const [selectedPlayground, setSelectedPlayground] =
    useState<Playground | null>(null);

  // Anthropic API key for Claude CLI
  const [apiKey, setApiKey] = useState("");

  // The actual skill to use - either from URL or user input
  const activeSkill = skillFromUrl || skillInput;

  // Check if ready to boot (has skill, selected repo, and API key)
  const canBoot = activeSkill.trim() && selectedPlayground && apiKey.trim();

  const handleBoot = async () => {
    if (!activeSkill.trim() || !selectedPlayground || !apiKey.trim()) {
      return;
    }

    setSandboxState({ status: "creating" });

    try {
      const response = await fetch("/api/sandbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Skill source (from URL)
          skillOwner: owner,
          skillRepo: repo,
          skillName: activeSkill.trim(),
          // Target repo to clone
          targetOwner: selectedPlayground.owner,
          targetRepo: selectedPlayground.repo,
          // Anthropic API key
          anthropicApiKey: apiKey.trim(),
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to create sandbox");
      }

      const data = await response.json();
      setSandboxState({
        status: "ready",
        sandboxId: data.sandboxId,
        ttydUrl: data.ttydUrl,
      });
    } catch (error) {
      setSandboxState({
        status: "error",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    handleBoot();
  };

  return (
    <main className="min-h-screen bg-black text-white font-mono">
      <div className="max-w-5xl mx-auto pt-8 px-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-4">
            <a href="/" className="flex items-center gap-4 hover:opacity-80">
              <div className="w-8 h-8 border border-white flex items-center justify-center">
                <div className="w-4 h-4 bg-orange-500 animate-pulse" />
              </div>
              <h1 className="text-2xl font-bold tracking-tighter">
                SKILLBOX.SH
              </h1>
            </a>
          </div>

          {/* Repository info */}
          <a
            href={`https://github.com/${owner}/${repo}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-gray-400 hover:text-white transition-colors"
          >
            {owner}/{repo} ↗
          </a>
        </div>

        {/* Skill info card */}
        <div className="border border-white/20 p-6 mb-6">
          <div className="text-orange-400/80 text-sm tracking-widest uppercase mb-2">
            {activeSkill ? "Skill Sandbox" : "Select a Skill"}
          </div>
          <h2 className="text-3xl font-bold mb-2">{activeSkill || repo}</h2>
          <p className="text-gray-400">
            {activeSkill
              ? `Try the ${activeSkill} skill from ${owner}/${repo}`
              : `Choose a skill from ${owner}/${repo} to get started`}
          </p>

          {/* Install command preview */}
          <div className="mt-4 bg-white/5 border border-white/10 p-3 font-mono text-sm">
            <span className="text-gray-500">$</span>{" "}
            <span className="text-white">
              npx skills add {owner}/{repo}
              {activeSkill && (
                <span className="text-orange-400"> --skill {activeSkill}</span>
              )}
            </span>
          </div>
        </div>

        {/* Sandbox setup area - shown when idle */}
        {sandboxState.status === "idle" && (
          <form onSubmit={handleSubmit}>
            {/* Step 1: Skill input (only if not provided in URL) */}
            {!skillFromUrl && (
              <div className="mb-6">
                <label className="block text-sm text-gray-400 mb-2">
                  1. Enter a skill name from this repository:
                </label>
                <div className="relative">
                  <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500">
                    --skill
                  </span>
                  <input
                    type="text"
                    value={skillInput}
                    onChange={(e) => setSkillInput(e.target.value)}
                    placeholder="rag-implementation"
                    className="w-full bg-black border border-white/20 p-4 pl-20 text-white placeholder:text-gray-600 focus:border-orange-500 focus:outline-none transition-colors"
                    autoFocus
                  />
                </div>
                <p className="mt-2 text-xs text-gray-600">
                  Tip: Check the repository for available skills in the skills/
                  or .cursor/skills/ directory
                </p>
              </div>
            )}

            {/* Step 2: Select a playground repo */}
            <div className="mb-6">
              <label className="block text-sm text-gray-400 mb-2">
                {skillFromUrl ? "1" : "2"}. Select a repository to use the skill
                on:
              </label>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {PLAYGROUNDS.map((pg) => {
                  const isSelected = selectedPlayground?.id === pg.id;
                  return (
                    <div
                      key={pg.id}
                      onClick={() => setSelectedPlayground(pg)}
                      className={`
                        group relative border p-4 transition-all duration-200 cursor-pointer
                        ${
                          isSelected
                            ? "border-orange-500 bg-orange-500/10"
                            : "border-white/10 bg-black hover:border-white/30 hover:bg-white/5"
                        }
                      `}
                    >
                      <div className="flex items-start justify-between">
                        <h3
                          className={`text-base font-bold mb-1 transition-colors ${
                            isSelected
                              ? "text-orange-500"
                              : "text-white group-hover:text-white"
                          }`}
                        >
                          {pg.title}
                        </h3>
                        <a
                          href={`https://github.com/${pg.owner}/${pg.repo}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className={`
                            p-1 -m-1 transition-all
                            ${
                              isSelected
                                ? "text-orange-500 hover:text-orange-400"
                                : "text-gray-600 hover:text-white"
                            }
                          `}
                          aria-label={`View ${pg.title} repository`}
                        >
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 16 16"
                            fill="none"
                            xmlns="http://www.w3.org/2000/svg"
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
                      <p className="text-xs text-gray-500">{pg.description}</p>
                      <div
                        className={`mt-2 text-[10px] tracking-wider ${
                          isSelected ? "text-orange-500/70" : "text-gray-600"
                        }`}
                      >
                        {isSelected ? "[ SELECTED ]" : `${pg.owner}/${pg.repo}`}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Step 3: Anthropic API Key */}
            <div className="mb-6">
              <label className="block text-sm text-gray-400 mb-2">
                {skillFromUrl ? "2" : "3"}. Enter your Anthropic API key:
              </label>
              <div className="relative">
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="api03-xxxxx..."
                  className="w-full bg-black border border-white/20 p-4 text-white placeholder:text-gray-600 focus:border-orange-500 focus:outline-none transition-colors font-mono"
                />
              </div>
              <p className="mt-2 text-xs text-gray-600">
                Your API key is sent securely to the sandbox and never stored.{" "}
                <a
                  href="https://console.anthropic.com/settings/keys"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-orange-500/70 hover:text-orange-500"
                >
                  Get an API key
                </a>
              </p>
            </div>

            {/* Boot button */}
            <button
              type="submit"
              disabled={!canBoot}
              className={`
                w-full py-6 border text-lg tracking-widest uppercase transition-all
                ${
                  canBoot
                    ? "border-orange-500 text-orange-500 hover:bg-orange-500 hover:text-black"
                    : "border-white/10 text-white/30 cursor-not-allowed"
                }
              `}
            >
              {!activeSkill.trim()
                ? "Enter a skill name"
                : !selectedPlayground
                  ? "Select a repository"
                  : !apiKey.trim()
                    ? "Enter your API key"
                    : `Boot ${selectedPlayground.title} with ${activeSkill}`}
            </button>
          </form>
        )}

        {sandboxState.status === "creating" && (
          <div className="border border-orange-500/50 p-8 text-center">
            <div className="text-orange-500 text-xl mb-4 animate-pulse">
              ◐ Creating Sandbox...
            </div>
            <p className="text-gray-500 text-sm">
              Cloning repository, installing dependencies, and starting
              terminal...
            </p>
            <div className="mt-4 text-xs text-gray-600">
              This may take 30-60 seconds
            </div>
          </div>
        )}

        {sandboxState.status === "error" && (
          <div className="border border-red-500/50 p-6">
            <p className="text-red-500 mb-4">Error: {sandboxState.error}</p>
            <button
              onClick={() => handleBoot()}
              className="px-4 py-2 border border-white/20 hover:border-white transition-colors"
            >
              Retry
            </button>
          </div>
        )}

        {sandboxState.status === "ready" && sandboxState.ttydUrl && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-gray-500">
                Sandbox ID: {sandboxState.sandboxId}
              </span>
              <a
                href={sandboxState.ttydUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-orange-400 hover:text-orange-300"
              >
                Open in New Tab ↗
              </a>
            </div>
            <div className="border border-white/20">
              <iframe
                src={sandboxState.ttydUrl}
                className="w-full h-[600px] bg-black"
                title="Sandbox Terminal"
              />
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
