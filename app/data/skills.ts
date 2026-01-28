export interface Skill {
  rank: number;
  name: string;
  author: string;
  installs: string;
}

export const TOP_SKILLS: Skill[] = [
  {
    rank: 1,
    name: "find-skills",
    author: "vercel-labs/skills",
    installs: "15.6K",
  },
  {
    rank: 2,
    name: "vercel-react-best-practices",
    author: "vercel-labs/agent-skills",
    installs: "5.9K",
  },
  {
    rank: 3,
    name: "remotion-best-practices",
    author: "remotion-dev/skills",
    installs: "5.2K",
  },
  {
    rank: 4,
    name: "web-design-guidelines",
    author: "vercel-labs/agent-skills",
    installs: "4.4K",
  },
  {
    rank: 5,
    name: "frontend-design",
    author: "anthropics/skills",
    installs: "3.0K",
  },
  {
    rank: 6,
    name: "vercel-composition-patterns",
    author: "vercel-labs/agent-skills",
    installs: "2.7K",
  },
  {
    rank: 7,
    name: "agent-browser",
    author: "vercel-labs/agent-browser",
    installs: "2.2K",
  },
  {
    rank: 8,
    name: "vercel-react-native-skills",
    author: "vercel-labs/agent-skills",
    installs: "2.0K",
  },
  {
    rank: 9,
    name: "atxp",
    author: "atxp-dev/cli",
    installs: "1.5K",
  },
  {
    rank: 10,
    name: "skill-creator",
    author: "anthropics/skills",
    installs: "1.4K",
  },
];

// Sandbox state for tracking sandbox lifecycle
export interface SandboxState {
  status: "idle" | "creating" | "ready" | "error";
  sandboxId?: string;
  ttydUrl?: string;
  error?: string;
}

// Playground repository for running skills
export interface Playground {
  id: string;
  title: string;
  owner: string;
  repo: string;
  description: string;
}

// Available playgrounds (Vercel repos)
export const PLAYGROUNDS: Playground[] = [
  {
    id: "commerce",
    title: "Commerce",
    owner: "vercel",
    repo: "commerce",
    description: "Next.js e-commerce template",
  },
  {
    id: "chat",
    title: "Chat",
    owner: "vercel",
    repo: "ai-chatbot",
    description: "AI SDK chatbot starter",
  },
  {
    id: "platforms",
    title: "Platforms",
    owner: "vercel",
    repo: "platforms",
    description: "Multi-tenant app template",
  },
];

// Request body for creating a sandbox
export interface CreateSandboxRequest {
  // The skill source (from URL)
  skillOwner: string;
  skillRepo: string;
  skillName: string;
  // The target repo to clone and use the skill on
  targetOwner: string;
  targetRepo: string;
  // Anthropic API key for Claude CLI
  anthropicApiKey: string;
}