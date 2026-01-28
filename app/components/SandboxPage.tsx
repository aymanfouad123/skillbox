"use client";

import { useState, useEffect } from "react";
import { SandboxState } from "../data/skills";

interface SandboxPageProps {
  owner: string;
  repo: string;
  skill?: string;
}

export function SandboxPage({ owner, repo, skill }: SandboxPageProps) {
  const [sandboxState, setSandboxState] = useState<SandboxState>({
    status: "idle",
  });
  const [autoBooted, setAutoBooted] = useState(false);

  useEffect(() => {
    if (!autoBooted) {
      handleBoot();
      setAutoBooted(true);
    }
  }, [autoBooted]);

  const handleBoot = async () => {
    setSandboxState({ status: "creating" });

    try {
      const response = await fetch("/api/sandbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          owner,
          repo,
          skills: skill ? [{ name: skill, author: `${owner}/${repo}` }] : [],
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
            {skill ? "Skill Sandbox" : "Repository Sandbox"}
          </div>
          <h2 className="text-3xl font-bold mb-2">{skill || repo}</h2>
          <p className="text-gray-400">
            {skill
              ? `Try the ${skill} skill from ${owner}/${repo}`
              : `Explore the ${repo} repository by ${owner}`}
          </p>

          {/* Install command preview */}
          <div className="mt-4 bg-white/5 border border-white/10 p-3 font-mono text-sm">
            <span className="text-gray-500">$</span>{" "}
            <span className="text-white">
              npx skills add {owner}/{repo}
              {skill && (
                <span className="text-orange-400"> --skill {skill}</span>
              )}
            </span>
          </div>
        </div>

        {/* Sandbox area */}
        {sandboxState.status === "idle" && (
          <button
            onClick={handleBoot}
            className="w-full py-6 border border-orange-500 text-orange-500 text-lg tracking-widest uppercase hover:bg-orange-500 hover:text-black transition-all"
          >
            Boot Sandbox
          </button>
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
              onClick={handleBoot}
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
