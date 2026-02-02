import { redirect } from "next/navigation";
import { SandboxPage } from "@/app/components/SandboxPage";

const MAX_SEGMENT_LENGTH = 200;
const VALID_SEGMENT = /^[a-zA-Z0-9._-]+$/;

function isValidHandle(value: string): boolean {
  if (!value || value.length > MAX_SEGMENT_LENGTH) return false;
  if (value.includes("..") || value.startsWith(".")) return false;
  return true;
}

function areValidHandles(owner: string, repo: string, skill: string): boolean {
  return (
    isValidHandle(owner) &&
    isValidHandle(repo) &&
    isValidHandle(skill) &&
    VALID_SEGMENT.test(owner) &&
    VALID_SEGMENT.test(repo) &&
    VALID_SEGMENT.test(skill)
  );
}

interface PageProps {
  params: Promise<{
    owner: string;
    repo: string;
    skill: string;
  }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { owner, repo, skill } = await params;
  if (!areValidHandles(owner, repo, skill)) {
    return { title: "Skillbox" };
  }
  return {
    title: `${skill} - ${owner}/${repo} | Skillbox`,
    description: `Try the ${skill} skill from ${owner}/${repo} in a live sandbox`,
  };
}

export default async function SkillSandboxPage({ params }: PageProps) {
  const { owner, repo, skill } = await params;

  if (!areValidHandles(owner, repo, skill)) {
    redirect("/");
  }

  return <SandboxPage owner={owner} repo={repo} skill={skill} />;
}
