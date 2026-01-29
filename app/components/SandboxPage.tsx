"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { SandboxState, PLAYGROUNDS, Playground } from "../data/skills";

const API_KEY_STORAGE_KEY = "skillbox_anthropic_api_key";
const SESSION_DURATION_SECONDS = 180; // 3 minutes

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
  const [skillInput, setSkillInput] = useState("");
  const [selectedPlayground, setSelectedPlayground] =
    useState<Playground | null>(null);
  const [customRepoUrl, setCustomRepoUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [rememberApiKey, setRememberApiKey] = useState(false);
  const [isKilling, setIsKilling] = useState(false);
  const [timeRemaining, setTimeRemaining] = useState(SESSION_DURATION_SECONDS);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // Load API key from localStorage on mount
  useEffect(() => {
    const savedKey = localStorage.getItem(API_KEY_STORAGE_KEY);
    if (savedKey) {
      setApiKey(savedKey);
      setRememberApiKey(true);
    }
  }, []);

  // Sync API key to localStorage
  useEffect(() => {
    if (rememberApiKey && apiKey.trim()) {
      localStorage.setItem(API_KEY_STORAGE_KEY, apiKey.trim());
    } else if (!rememberApiKey) {
      localStorage.removeItem(API_KEY_STORAGE_KEY);
    }
  }, [apiKey, rememberApiKey]);

  const handleKillSandbox = useCallback(async () => {
    if (!sandboxState.sandboxId || isKilling) return;

    setIsKilling(true);
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    try {
      await fetch("/api/sandbox", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sandboxId: sandboxState.sandboxId }),
      });
    } catch (error) {
      console.error("Failed to kill sandbox:", error);
    } finally {
      setSandboxState({ status: "idle" });
      setTimeRemaining(SESSION_DURATION_SECONDS);
      setIsKilling(false);
    }
  }, [sandboxState.sandboxId, isKilling]);

  // Session timer - countdown and auto-kill
  useEffect(() => {
    if (sandboxState.status !== "ready") {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      return;
    }

    setTimeRemaining(SESSION_DURATION_SECONDS);
    timerRef.current = setInterval(() => {
      setTimeRemaining((prev) => {
        if (prev <= 1) {
          handleKillSandbox();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [sandboxState.status, handleKillSandbox]);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const activeSkill = skillFromUrl || skillInput;

  // Parse "owner/repo" or "https://github.com/owner/repo" formats
  const customRepo = (() => {
    const trimmed = customRepoUrl.trim();
    if (!trimmed) return null;
    const match = trimmed.match(/(?:github\.com\/)?([^\/]+)\/([^\/]+)/);
    if (!match) return null;
    return { owner: match[1], repo: match[2].replace(/\.git$/, "") };
  })();

  const targetOwner = selectedPlayground?.owner ?? customRepo?.owner;
  const targetRepo = selectedPlayground?.repo ?? customRepo?.repo;
  const canBoot =
    activeSkill.trim() && targetOwner && targetRepo && apiKey.trim();

  const handleBoot = async () => {
    if (!canBoot) return;

    setSandboxState({ status: "creating" });

    try {
      const response = await fetch("/api/sandbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          skillOwner: owner,
          skillRepo: repo,
          skillName: activeSkill.trim(),
          targetOwner,
          targetRepo,
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

  const getButtonText = () => {
    if (!activeSkill.trim()) return "Enter a skill name";
    if (!targetOwner || !targetRepo) return "Select a repository";
    if (!apiKey.trim()) return "Enter your API key";
    const repoName =
      selectedPlayground?.title ?? `${targetOwner}/${targetRepo}`;
    return `Boot ${repoName} with ${activeSkill}`;
  };

  return (
    <main className="min-h-screen bg-black text-white font-mono">
      <div className="max-w-5xl mx-auto pt-12 pb-24 px-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <a href="/" className="flex items-center gap-4 hover:opacity-80">
            <div className="w-8 h-8 border border-white flex items-center justify-center">
              <div className="w-4 h-4 bg-orange-500 animate-pulse" />
            </div>
            <h1 className="text-2xl font-bold tracking-tighter">SKILLBOX.SH</h1>
          </a>
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
            {activeSkill
              ? "Isolated Laboratory for AI Agent Skills"
              : "Select a Skill"}
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
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleBoot();
            }}
          >
            {/* Skill input (only if not provided in URL) */}
            {!skillFromUrl && (
              <div className="mb-6">
                <label className="block text-sm text-gray-400 mb-2">
                  Enter a skill name from this repository:
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
                    className="w-full bg-black border border-white/20 p-4 pl-20 text-white placeholder:text-gray-600 focus:border-orange-500 focus:outline-none"
                    autoFocus
                  />
                </div>
                <p className="mt-2 text-xs text-gray-600">
                  Tip: Check the repository for available skills in skills/ or
                  .cursor/skills/
                </p>
              </div>
            )}

            {/* Select a playground repo */}
            <div className="mb-6">
              <label className="block text-sm text-gray-400 mb-2">
                1. Select a repository to use the skill on:
              </label>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {PLAYGROUNDS.map((pg) => {
                  const isSelected = selectedPlayground?.id === pg.id;
                  return (
                    <div
                      key={pg.id}
                      onClick={() => setSelectedPlayground(pg)}
                      className={`border p-4 cursor-pointer transition-colors ${
                        isSelected
                          ? "border-orange-500 bg-orange-500/10"
                          : "border-white/10 hover:border-white/30"
                      }`}
                    >
                      <div className="flex items-start justify-between">
                        <h3
                          className={`text-base font-bold mb-1 ${isSelected ? "text-orange-500" : "text-white"}`}
                        >
                          {pg.title}
                        </h3>
                        <a
                          href={`https://github.com/${pg.owner}/${pg.repo}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="text-gray-600 hover:text-white"
                        >
                          ↗
                        </a>
                      </div>
                      <p className="text-xs text-gray-500">{pg.description}</p>
                      <div
                        className={`mt-2 text-[10px] tracking-wider ${isSelected ? "text-orange-500/70" : "text-gray-600"}`}
                      >
                        {isSelected ? "[ SELECTED ]" : `${pg.owner}/${pg.repo}`}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Custom GitHub URL input */}
              <div className="mt-4">
                <div className="text-center text-xs text-gray-500 mb-3 tracking-wider">
                  — OR ENTER A PUBLIC GITHUB URL —
                </div>
                <input
                  type="text"
                  value={customRepoUrl}
                  onChange={(e) => {
                    setCustomRepoUrl(e.target.value);
                    if (e.target.value.trim()) setSelectedPlayground(null);
                  }}
                  placeholder="https://github.com/owner/repo"
                  className={`w-full bg-black border p-4 text-white placeholder:text-gray-600 focus:outline-none font-mono ${
                    customRepoUrl.trim() && !selectedPlayground
                      ? "border-orange-500"
                      : "border-white/20 focus:border-orange-500"
                  }`}
                />
              </div>
            </div>

            {/* Anthropic API Key */}
            <div className="mb-6">
              <label className="block text-sm text-gray-400 mb-2">
                2. Enter your Anthropic API key:
              </label>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-ant-xxxxx..."
                className="w-full bg-black border border-white/20 p-4 text-white placeholder:text-gray-600 focus:border-orange-500 focus:outline-none font-mono"
              />
              <div className="mt-3 flex items-center justify-between">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={rememberApiKey}
                    onChange={(e) => setRememberApiKey(e.target.checked)}
                    className="w-4 h-4 bg-black border border-white/20 appearance-none cursor-pointer checked:bg-orange-500 checked:border-orange-500 relative after:content-[''] after:absolute after:hidden checked:after:block after:left-[5px] after:top-[2px] after:w-[4px] after:h-[8px] after:border-black after:border-r-2 after:border-b-2 after:rotate-45"
                  />
                  <span className="text-xs text-gray-500">
                    Remember my API key
                  </span>
                </label>
                {rememberApiKey && apiKey && (
                  <button
                    type="button"
                    onClick={() => {
                      setApiKey("");
                      setRememberApiKey(false);
                    }}
                    className="text-xs text-red-500/70 hover:text-red-500"
                  >
                    Clear saved key
                  </button>
                )}
              </div>
              <p className="mt-2 text-xs text-gray-600">
                {rememberApiKey
                  ? "Stored locally in your browser."
                  : "Your API key is sent securely to the sandbox."}{" "}
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
              className={`w-full mt-6 py-6 border text-lg tracking-widest uppercase ${
                canBoot
                  ? "border-orange-500 text-orange-500 hover:bg-orange-500 hover:text-black"
                  : "border-white/10 text-white/30 cursor-not-allowed"
              }`}
            >
              {getButtonText()}
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
          <div className="pb-8">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-gray-500">
                Sandbox ID: {sandboxState.sandboxId}
              </span>
              <div className="flex items-center gap-4">
                <span
                  className={`text-xs font-mono ${timeRemaining <= 30 ? "text-red-500" : "text-orange-400"}`}
                >
                  {formatTime(timeRemaining)}
                </span>
                <button
                  onClick={handleKillSandbox}
                  disabled={isKilling}
                  className={`text-xs px-3 py-1 border ${
                    isKilling
                      ? "border-gray-600 text-gray-600 cursor-not-allowed"
                      : "border-red-500/50 text-red-500 hover:bg-red-500 hover:text-black"
                  }`}
                >
                  {isKilling ? "Killing..." : "Kill Session"}
                </button>
              </div>
            </div>
            <div className="border border-white/20 rounded overflow-hidden">
              <iframe
                src={sandboxState.ttydUrl}
                className="w-full bg-black"
                style={{
                  height: "calc(100vh - 200px)",
                  minHeight: "500px",
                  maxHeight: "800px",
                }}
                title="Sandbox Terminal"
                allow="clipboard-read; clipboard-write"
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
              />
            </div>
            <p className="mt-2 text-xs text-gray-600 text-center">
              Tip: Click inside the terminal to focus. Use Ctrl+Shift+V to
              paste.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
