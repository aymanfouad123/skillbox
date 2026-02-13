"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Github, Download } from "lucide-react";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "../../convex/_generated/api";
import { PLAYGROUNDS, Playground, CLIProvider } from "../data/skills";

const API_KEY_STORAGE_KEY = "skillbox_anthropic_api_key";
const USER_ID_STORAGE_KEY = "skillbox_user_id";
const SESSION_DURATION_SECONDS = 360; // 6 minutes

// Generate or retrieve a persistent user ID for this browser session
function getUserId(): string {
  if (typeof window === "undefined") return "";

  let userId = localStorage.getItem(USER_ID_STORAGE_KEY);
  if (!userId) {
    userId = `user-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    localStorage.setItem(USER_ID_STORAGE_KEY, userId);
  }
  return userId;
}

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
  const [skillInput, setSkillInput] = useState("");
  const [selectedPlayground, setSelectedPlayground] =
    useState<Playground | null>(null);
  const [customRepoUrl, setCustomRepoUrl] = useState("");
  const [cliProvider, setCLIProvider] = useState<CLIProvider>("opencode");
  const [apiKey, setApiKey] = useState("");
  const [rememberApiKey, setRememberApiKey] = useState(false);
  const [isBooting, setIsBooting] = useState(false);
  const [isKilling, setIsKilling] = useState(false);
  const [timeRemaining, setTimeRemaining] = useState(SESSION_DURATION_SECONDS);
  const [localError, setLocalError] = useState<string | null>(null);
  const [isFulfillingQueue, setIsFulfillingQueue] = useState(false);
  // When Claude fulfillment fails after claim, we can offer re-join with same skill
  const [failedClaimInfo, setFailedClaimInfo] = useState<{
    skill: string;
    cliProvider: "claude";
  } | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  // Prevent duplicate queue fulfillment attempts
  const fulfillingQueueRef = useRef(false);

  // Get persistent user ID
  const userId = useMemo(() => getUserId(), []);

  // Convex queries and mutations
  const userStatus = useQuery(api.sandboxes.getUserStatus, { userId });
  const activeSandboxCount = useQuery(api.sandboxes.getActiveSandboxCount, {});
  const registerSandboxMutation = useMutation(api.sandboxes.registerSandbox);
  const addToQueueMutation = useMutation(api.sandboxes.addToQueue);
  const stopSandboxMutation = useMutation(api.sandboxes.stopSandbox);
  const cancelQueueMutation = useMutation(api.sandboxes.cancelQueue);
  const claimQueueSlotMutation = useMutation(api.sandboxes.claimQueueSlot);
  const sendHeartbeatMutation = useMutation(api.sandboxes.sendHeartbeat);
  const removeFromQueueMutation = useMutation(api.sandboxes.removeFromQueue);
  const extendTimeoutAction = useAction(api.sandboxes.extendTimeout);

  // Derive state from Convex query
  const sandboxState = useMemo(() => {
    if (!userStatus) return { status: "loading" as const };

    if (userStatus.type === "sandbox") {
      return {
        status: "ready" as const,
        sandboxId: userStatus.sandboxId,
        ttydUrl: userStatus.ttydUrl,
        previewUrl: userStatus.previewUrl,
        previewReady: userStatus.previewReady ?? false,
        expiresAt: userStatus.expiresAt,
        hasExtendedTimeout: userStatus.hasExtendedTimeout ?? false,
      };
    }

    if (userStatus.type === "queued") {
      return {
        status: "queued" as const,
        position: userStatus.position,
        readyToFulfill: userStatus.readyToFulfill,
        skill: userStatus.skill,
        cliProvider: userStatus.cliProvider,
      };
    }

    return {
      status: "idle" as const,
      hasCapacity: userStatus.hasCapacity,
    };
  }, [userStatus]);

  // Load API key from localStorage on mount
  useEffect(() => {
    const savedKey = localStorage.getItem(API_KEY_STORAGE_KEY);
    if (savedKey) {
      setApiKey(savedKey);
      setRememberApiKey(true);
    }
  }, []);

  // Load latched playground from sessionStorage (set on landing page)
  useEffect(() => {
    const latchedPlayground = sessionStorage.getItem("skillbox-playground");
    if (latchedPlayground) {
      const found = PLAYGROUNDS.find((p) => p.id === latchedPlayground);
      if (found) setSelectedPlayground(found);
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

  // Heartbeat effect for Claude users in queue
  // Sends heartbeat every 10 seconds to prove browser is still connected
  useEffect(() => {
    if (
      sandboxState.status !== "queued" ||
      !("cliProvider" in sandboxState) ||
      sandboxState.cliProvider !== "claude" ||
      isFulfillingQueue
    ) {
      return;
    }

    // Send immediate heartbeat
    sendHeartbeatMutation({ userId }).catch(console.error);

    // Send heartbeat every 10 seconds
    const interval = setInterval(() => {
      sendHeartbeatMutation({ userId }).catch(console.error);
    }, 10 * 1000);

    return () => clearInterval(interval);
  }, [sandboxState, userId, sendHeartbeatMutation, isFulfillingQueue]);

  // Immediate exit: remove from queue on page unload (beforeunload)
  useEffect(() => {
    if (
      sandboxState.status !== "queued" ||
      !("cliProvider" in sandboxState) ||
      sandboxState.cliProvider !== "claude"
    ) {
      return;
    }

    const handleBeforeUnload = () => {
      // Use sendBeacon for reliable delivery during page unload
      // We need to call a Convex HTTP endpoint for this
      // For now, we'll try the mutation (may not complete)
      removeFromQueueMutation({ userId }).catch(() => {
        // Ignore errors - heartbeat expiry will clean up
      });
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [sandboxState, userId, removeFromQueueMutation]);

  // Handle client-side queue fulfillment for Claude BYOK
  // When a Claude user's queue slot is ready, create sandbox with API key from localStorage
  useEffect(() => {
    if (
      sandboxState.status !== "queued" ||
      !("readyToFulfill" in sandboxState) ||
      !sandboxState.readyToFulfill ||
      sandboxState.cliProvider !== "claude" ||
      fulfillingQueueRef.current
    ) {
      return;
    }

    const fulfillQueue = async () => {
      // Prevent duplicate attempts
      if (fulfillingQueueRef.current) return;
      fulfillingQueueRef.current = true;
      setIsFulfillingQueue(true);
      setLocalError(null);
      setFailedClaimInfo(null);

      try {
        // Get API key from localStorage
        const storedApiKey = localStorage.getItem(API_KEY_STORAGE_KEY);
        if (!storedApiKey) {
          setLocalError(
            "API key not found. Please re-enter your Anthropic API key."
          );
          // Cancel the queue entry since we can't fulfill it
          await cancelQueueMutation({ userId });
          return;
        }

        // Claim the queue slot (atomically removes from queue)
        const claimResult = await claimQueueSlotMutation({ userId });
        if (!claimResult.success) {
          // Slot was taken or no longer available, query will update
          return;
        }

        // Store so we can offer re-join if sandbox creation fails after claim (always Claude here)
        if (claimResult.skill && claimResult.cliProvider === "claude") {
          setFailedClaimInfo({
            skill: claimResult.skill,
            cliProvider: "claude",
          });
        }

        // Parse skill to get components
        const skillParts = claimResult.skill?.split("/") || [];
        if (skillParts.length < 3) {
          setLocalError("Invalid skill format in queue");
          return;
        }

        const [skillOwner, skillRepo, ...skillNameParts] = skillParts;
        const skillName = skillNameParts.join("/");

        // Create sandbox with API key
        const response = await fetch("/api/sandbox", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            skillOwner,
            skillRepo,
            skillName,
            // Use fresh Next.js for queued sessions
            targetOwner: "_create",
            targetRepo: "nextjs",
            cliProvider: "claude",
            anthropicApiKey: storedApiKey,
          }),
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error || "Failed to create sandbox");
        }

        const data = await response.json();

        // Register the sandbox with Vercel timing
        const registerResult = await registerSandboxMutation({
          userId,
          sandboxId: data.sandboxId,
          ttydUrl: data.ttydUrl,
          previewUrl: data.previewUrl,
          skill: claimResult.skill!,
          cliProvider: "claude",
          vercelCreatedAt: data.vercelCreatedAt,
          vercelTimeout: data.vercelTimeout,
        });

        if (!registerResult.success) {
          // Clean up Vercel sandbox
          try {
            await fetch("/api/sandbox", {
              method: "DELETE",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sandboxId: data.sandboxId }),
            });
          } catch {
            // Best effort cleanup
          }
          throw new Error(registerResult.error || "Failed to register sandbox");
        }

        setFailedClaimInfo(null);
      } catch (error) {
        setLocalError(
          error instanceof Error ? error.message : "Failed to create sandbox"
        );
      } finally {
        fulfillingQueueRef.current = false;
        setIsFulfillingQueue(false);
      }
    };

    fulfillQueue();
  }, [
    sandboxState,
    userId,
    claimQueueSlotMutation,
    cancelQueueMutation,
    registerSandboxMutation,
  ]);

  const [isExtending, setIsExtending] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);

  const handleDownload = useCallback(async () => {
    if (sandboxState.status !== "ready" || !("sandboxId" in sandboxState) || isDownloading) return;
    setIsDownloading(true);
    try {
      const res = await fetch("/api/sandbox/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sandboxId: sandboxState.sandboxId,
          userId,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error || "Download failed");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "sandbox-repo.tar.gz";
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error("Download failed:", e);
    } finally {
      setIsDownloading(false);
    }
  }, [sandboxState, userId, isDownloading]);

  const handleKillSandbox = useCallback(async () => {
    if (isKilling) return;

    setIsKilling(true);
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    try {
      await stopSandboxMutation({ userId });
    } catch (error) {
      console.error("Failed to kill sandbox:", error);
    } finally {
      setTimeRemaining(SESSION_DURATION_SECONDS);
      setIsKilling(false);
    }
  }, [isKilling, stopSandboxMutation, userId]);

  const handleExtendTimeout = useCallback(async () => {
    if (isExtending) return;

    setIsExtending(true);
    try {
      const result = await extendTimeoutAction({ userId });
      if (result.success && result.newExpiresAt) {
        // Update timer with new expiration
        const remaining = Math.max(
          0,
          Math.floor((result.newExpiresAt - Date.now()) / 1000)
        );
        setTimeRemaining(remaining);
      }
    } catch (error) {
      console.error("Failed to extend timeout:", error);
    } finally {
      setIsExtending(false);
    }
  }, [isExtending, extendTimeoutAction, userId]);

  const handleCancelQueue = useCallback(async () => {
    try {
      await cancelQueueMutation({ userId });
    } catch (error) {
      console.error("Failed to cancel queue:", error);
    }
  }, [cancelQueueMutation, userId]);

  const activeSandboxId =
    sandboxState.status === "ready" ? sandboxState.sandboxId : null;
  const activeSandboxExpiresAt =
    sandboxState.status === "ready" ? sandboxState.expiresAt : null;

  // Keep countdown value in sync with server expiration updates (e.g. extend)
  useEffect(() => {
    if (!activeSandboxExpiresAt) return;
    const remaining = Math.max(
      0,
      Math.floor((activeSandboxExpiresAt - Date.now()) / 1000)
    );
    setTimeRemaining(remaining);
  }, [activeSandboxExpiresAt]);

  // Session timer interval lifecycle
  useEffect(() => {
    if (!activeSandboxId) {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      setTimeRemaining(SESSION_DURATION_SECONDS);
      return;
    }

    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
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
  }, [activeSandboxId, handleKillSandbox]);

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

  // If we have a valid GitHub repo, use it exclusively (disable playground selection)
  const hasGithubRepo = customRepo !== null;
  const targetOwner = hasGithubRepo
    ? customRepo.owner
    : selectedPlayground?.owner;
  const targetRepo = hasGithubRepo ? customRepo.repo : selectedPlayground?.repo;

  // OpenCode doesn't require API key, Claude does
  const canBoot =
    activeSkill.trim() &&
    targetOwner &&
    targetRepo &&
    (cliProvider === "opencode" || apiKey.trim()) &&
    sandboxState.status === "idle" &&
    !isBooting;

  const handleBoot = async () => {
    if (!canBoot || !targetOwner || !targetRepo) return;

    setLocalError(null);
    setIsBooting(true);

    const skill = `${owner}/${repo}/${activeSkill.trim()}`;

    try {
      // Check if at capacity
      if (
        sandboxState.status === "idle" &&
        "hasCapacity" in sandboxState &&
        !sandboxState.hasCapacity
      ) {
        // Add to queue instead
        const result = await addToQueueMutation({
          userId,
          skill,
          cliProvider,
        });

        if (!result.success) {
          throw new Error(result.error || "Failed to join queue");
        }
        return;
      }

      // Step 1: Create sandbox via API first
      const response = await fetch("/api/sandbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          skillOwner: owner,
          skillRepo: repo,
          skillName: activeSkill.trim(),
          targetOwner,
          targetRepo,
          cliProvider,
          ...(cliProvider === "claude" && {
            anthropicApiKey: apiKey.trim(),
          }),
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to create sandbox");
      }

      const data = await response.json();

      // Step 2: Register in Convex with complete data including Vercel timing
      const registerResult = await registerSandboxMutation({
        userId,
        sandboxId: data.sandboxId,
        ttydUrl: data.ttydUrl,
        previewUrl: data.previewUrl,
        skill,
        cliProvider,
        // Pass Vercel timing for accurate countdown
        vercelCreatedAt: data.vercelCreatedAt,
        vercelTimeout: data.vercelTimeout,
      });

      if (!registerResult.success) {
        // Clean up the Vercel sandbox since we couldn't register it
        try {
          await fetch("/api/sandbox", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sandboxId: data.sandboxId }),
          });
        } catch {
          // Best effort cleanup, ignore errors
        }

        if (registerResult.error === "at_capacity") {
          // Race condition - add to queue instead
          await addToQueueMutation({ userId, skill, cliProvider });
        } else {
          throw new Error(registerResult.error || "Failed to register sandbox");
        }
      }
    } catch (error) {
      setLocalError(
        error instanceof Error ? error.message : "Failed to create sandbox"
      );
    } finally {
      setIsBooting(false);
    }
  };

  const getButtonText = () => {
    if (isBooting) return "Creating...";
    if (sandboxState.status !== "idle") return "Sandbox Active";
    if (!activeSkill.trim()) return "Enter a skill name";
    if (!targetOwner || !targetRepo) return "Select a repository";
    if (cliProvider === "claude" && !apiKey.trim()) return "Enter your API key";
    const repoName =
      selectedPlayground?.title ?? `${targetOwner}/${targetRepo}`;
    const cliName = cliProvider === "opencode" ? "OpenCode" : "Claude";
    return `Boot ${repoName} with ${cliName}`;
  };

  // Get estimated wait time for queue
  const getEstimatedWait = (position: number) => {
    const minutes = Math.ceil(position * 1.5);
    if (minutes < 1) return "less than a minute";
    if (minutes === 1) return "about 1 minute";
    return `about ${minutes} minutes`;
  };

  return (
    <main className="min-h-screen bg-black text-white font-mono">
      <div className="max-w-5xl mx-auto pt-12 pb-24 px-6">
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
            <a
              href="https://github.com/aymanfouad123/skillbox"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-2 mx-2 sm:px-3 py-1.5 border border-white/20 hover:border-yellow-500/50 hover:bg-yellow-500/10 transition-all text-sm text-gray-400 hover:text-yellow-500"
            >
              <Github className="w-4 h-4" />
              <span className="hidden sm:inline">Star on GitHub</span>
              <span className="sm:hidden">Star</span>
            </a>
          </div>
          <a
            href={`https://github.com/${owner}/${repo}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-gray-400 hover:text-white transition-colors text-sm sm:text-base truncate max-w-[150px] sm:max-w-none"
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

        {/* Active sandbox count indicator */}
        {activeSandboxCount !== undefined && (
          <div className="mb-4 text-xs text-gray-500 text-right">
            {activeSandboxCount}/150 sandboxes active
          </div>
        )}

        {/* Error message */}
        {localError && (
          <div className="mb-6 border border-red-500/50 p-4">
            <p className="text-red-500 text-sm">{localError}</p>
            {failedClaimInfo && (
              <p className="mt-2 text-xs text-gray-400">
                You left the queue when your slot was ready. You can re-join at
                the back of the queue.
              </p>
            )}
            <div className="mt-2 flex flex-wrap gap-2">
              {failedClaimInfo && (
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await addToQueueMutation({
                        userId,
                        skill: failedClaimInfo.skill,
                        cliProvider: failedClaimInfo.cliProvider,
                      });
                      setLocalError(null);
                      setFailedClaimInfo(null);
                    } catch (e) {
                      console.error("Re-join queue failed:", e);
                    }
                  }}
                  className="text-xs px-3 py-1.5 border border-orange-500/50 text-orange-500 hover:bg-orange-500/10"
                >
                  Re-join queue
                </button>
              )}
              <button
                onClick={() => {
                  setLocalError(null);
                  setFailedClaimInfo(null);
                }}
                className="text-xs text-gray-400 hover:text-white"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {/* Sandbox setup area - shown when idle */}
        {(sandboxState.status === "idle" ||
          sandboxState.status === "loading") &&
          !isBooting && (
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
                    const isDisabled = hasGithubRepo;
                    return (
                      <div
                        key={pg.id}
                        onClick={() => !isDisabled && setSelectedPlayground(pg)}
                        className={`border p-4 transition-colors ${
                          isDisabled
                            ? "cursor-not-allowed opacity-40 border-white/10"
                            : isSelected
                            ? "border-orange-500 bg-orange-500/10 cursor-pointer"
                            : "border-white/10 hover:border-white/30 cursor-pointer"
                        }`}
                      >
                        <div className="flex items-start justify-between">
                          <h3
                            className={`text-base font-bold mb-1 ${
                              isSelected ? "text-orange-500" : "text-white"
                            }`}
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
                        <p className="text-xs text-gray-500">
                          {pg.description}
                        </p>
                        <div
                          className={`mt-2 text-[10px] tracking-wider ${
                            isSelected ? "text-orange-500/70" : "text-gray-600"
                          }`}
                        >
                          {isSelected
                            ? "[ SELECTED ]"
                            : `${pg.owner}/${pg.repo}`}
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
                      const newValue = e.target.value;
                      setCustomRepoUrl(newValue);
                      // Clear playground selection when entering a custom URL
                      if (newValue.trim()) {
                        setSelectedPlayground(null);
                      }
                    }}
                    placeholder="https://github.com/owner/repo"
                    className={`w-full bg-black border p-4 text-white placeholder:text-gray-600 focus:outline-none font-mono ${
                      hasGithubRepo
                        ? "border-orange-500"
                        : "border-white/20 focus:border-orange-500"
                    }`}
                  />
                  {hasGithubRepo && (
                    <p className="mt-2 text-xs text-orange-500/70">
                      Using custom repository: {customRepo.owner}/
                      {customRepo.repo}
                    </p>
                  )}
                </div>
              </div>

              {/* CLI Provider Selection */}
              <div className="mb-6">
                <label className="block text-sm text-gray-400 mb-2">
                  2. Choose your AI coding assistant:
                </label>
                <div className="grid grid-cols-2 gap-4">
                  {/* OpenCode Option */}
                  <div
                    onClick={() => setCLIProvider("opencode")}
                    className={`border p-4 cursor-pointer transition-colors ${
                      cliProvider === "opencode"
                        ? "border-green-500 bg-green-500/10"
                        : "border-white/10 hover:border-white/30"
                    }`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <h3
                        className={`text-base font-bold ${
                          cliProvider === "opencode"
                            ? "text-green-500"
                            : "text-white"
                        }`}
                      >
                        OpenCode
                      </h3>
                      <span className="text-[10px] px-2 py-0.5 bg-green-500/20 text-green-400 border border-green-500/30">
                        FREE
                      </span>
                    </div>
                    <p className="text-xs text-gray-500">
                      Free AI coding CLI. No API key required.
                    </p>
                    <div
                      className={`mt-2 text-[10px] tracking-wider ${
                        cliProvider === "opencode"
                          ? "text-green-500/70"
                          : "text-gray-600"
                      }`}
                    >
                      {cliProvider === "opencode"
                        ? "[ SELECTED ]"
                        : "gpt-5-nano model"}
                    </div>
                  </div>

                  {/* Claude Option */}
                  <div
                    onClick={() => setCLIProvider("claude")}
                    className={`border p-4 cursor-pointer transition-colors ${
                      cliProvider === "claude"
                        ? "border-orange-500 bg-orange-500/10"
                        : "border-white/10 hover:border-white/30"
                    }`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <h3
                        className={`text-base font-bold ${
                          cliProvider === "claude"
                            ? "text-orange-500"
                            : "text-white"
                        }`}
                      >
                        Claude
                      </h3>
                      <span className="text-[10px] px-2 py-0.5 bg-orange-500/20 text-orange-400 border border-orange-500/30">
                        API KEY
                      </span>
                    </div>
                    <p className="text-xs text-gray-500">
                      Anthropic Claude CLI. Requires API key.
                    </p>
                    <div
                      className={`mt-2 text-[10px] tracking-wider ${
                        cliProvider === "claude"
                          ? "text-orange-500/70"
                          : "text-gray-600"
                      }`}
                    >
                      {cliProvider === "claude"
                        ? "[ SELECTED ]"
                        : "claude-sonnet-4"}
                    </div>
                  </div>
                </div>
              </div>

              {/* Anthropic API Key - Only shown for Claude */}
              {cliProvider === "claude" && (
                <div className="mb-6">
                  <label className="block text-sm text-gray-400 mb-2">
                    3. Enter your Anthropic API key:
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
              )}

              {/* Boot button */}
              <button
                type="submit"
                disabled={!canBoot}
                className={`w-full mt-6 py-6 border text-lg tracking-widest uppercase ${
                  canBoot
                    ? "border-orange-500 text-orange-500 hover:bg-orange-500 hover:text-black cursor-pointer"
                    : "border-white/10 text-white/30 cursor-not-allowed"
                }`}
              >
                {getButtonText()}
              </button>
            </form>
          )}

        {/* Queue status - shown when user is waiting in queue */}
        {sandboxState.status === "queued" && !isFulfillingQueue && (
          <div className="border border-yellow-500/50 p-8 text-center">
            <div className="text-yellow-500 text-xl mb-4">
              ⏳ You&apos;re in the Queue
            </div>
            <div className="text-4xl font-bold text-yellow-400 mb-2">
              #{sandboxState.position}
            </div>
            <p className="text-gray-400 text-sm mb-4">
              Estimated wait: {getEstimatedWait(sandboxState.position)}
            </p>
            <p className="text-gray-600 text-xs mb-4">
              We&apos;re at capacity (150 sandboxes). You&apos;ll be
              automatically moved forward as slots open up.
            </p>
            <button
              onClick={handleCancelQueue}
              className="px-4 py-2 border border-white/20 hover:border-red-500/50 hover:text-red-500 transition-colors text-sm"
            >
              Cancel
            </button>
          </div>
        )}

        {/* Queue fulfillment - shown when creating sandbox from queue (Claude BYOK) */}
        {isFulfillingQueue && (
          <div className="border border-orange-500/50 p-8 text-center">
            <div className="text-orange-500 text-xl mb-4 animate-pulse">
              ◐ Your Turn - Creating Sandbox...
            </div>
            <p className="text-gray-500 text-sm">
              Cloning repository, installing dependencies, and starting terminal
              with your API key...
            </p>
            <div className="mt-4 text-xs text-gray-600">
              This may take 30-60 seconds
            </div>
          </div>
        )}

        {/* Creating state - shown during API call */}
        {isBooting && (
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

        {sandboxState.status === "ready" && "ttydUrl" in sandboxState && (
          <div className="pb-8">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 mb-2">
              <span className="text-xs text-gray-500 shrink-0 min-w-0 max-w-full truncate">
                Sandbox ID: {sandboxState.sandboxId}
              </span>
              <div className="flex flex-wrap items-center gap-2 sm:gap-4 min-w-0">
                <span
                  className={`text-xs font-mono shrink-0 whitespace-nowrap ${
                    timeRemaining <= 30 ? "text-red-500" : "text-orange-400"
                  }`}
                >
                  {formatTime(timeRemaining)}
                </span>
                {/* Preview - enabled only when dev server is ready (previewReady from Convex) */}
                {"previewUrl" in sandboxState && sandboxState.previewUrl && (
                  sandboxState.previewReady ? (
                    <a
                      href={sandboxState.previewUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs px-2 sm:px-3 py-1.5 sm:py-1 min-h-[28px] sm:min-h-0 inline-flex items-center justify-center border border-blue-500/50 text-blue-500 hover:bg-blue-500 hover:text-black shrink-0 whitespace-nowrap"
                    >
                      Preview
                    </a>
                  ) : (
                    <span className="text-xs px-2 sm:px-3 py-1.5 sm:py-1 min-h-[28px] sm:min-h-0 inline-flex items-center border border-white/20 text-gray-500 shrink-0 whitespace-nowrap">
                      Preview booting…
                    </span>
                  )
                )}
                {/* Download sandbox workspace as tarball */}
                <button
                  type="button"
                  onClick={handleDownload}
                  disabled={isDownloading}
                  className="text-xs px-2 sm:px-3 py-1.5 sm:py-1 min-h-[28px] sm:min-h-0 border border-white/30 text-gray-300 hover:bg-white/10 hover:text-white inline-flex items-center justify-center gap-1.5 disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed shrink-0 whitespace-nowrap"
                >
                  <Download className="w-3.5 h-3.5 shrink-0" />
                  {isDownloading ? "Preparing…" : "Download"}
                </button>
                {/* Extend button - only shown if not already extended and time is low */}
                {!sandboxState.hasExtendedTimeout && timeRemaining <= 120 && (
                  <button
                    onClick={handleExtendTimeout}
                    disabled={isExtending}
                    className={`text-xs px-2 sm:px-3 py-1.5 sm:py-1 min-h-[28px] sm:min-h-0 border shrink-0 whitespace-nowrap inline-flex items-center justify-center ${
                      isExtending
                        ? "border-gray-600 text-gray-600 cursor-not-allowed"
                        : "border-green-500/50 text-green-500 hover:bg-green-500 hover:text-black cursor-pointer"
                    }`}
                  >
                    {isExtending ? "Extending..." : "+2 min"}
                  </button>
                )}
                <button
                  onClick={handleKillSandbox}
                  disabled={isKilling}
                  className={`text-xs px-2 sm:px-3 py-1.5 sm:py-1 min-h-[28px] sm:min-h-0 border shrink-0 whitespace-nowrap inline-flex items-center justify-center ${
                    isKilling
                      ? "border-gray-600 text-gray-600 cursor-not-allowed"
                      : "border-red-500/50 text-red-500 hover:bg-red-500 hover:text-black cursor-pointer"
                  }`}
                >
                  {isKilling ? "Killing..." : "Kill Session"}
                </button>
              </div>
            </div>
            <div className="border border-white/20 rounded overflow-hidden">
              <iframe
                src={sandboxState.ttydUrl}
                className="w-full bg-black h-[calc(100dvh-200px)] min-h-[400px] sm:min-h-[500px] max-h-[800px]"
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
