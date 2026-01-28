import { SandboxPage } from "@/app/components/SandboxPage";

interface PageProps {
  params: Promise<{
    owner: string;
    repo: string;
    skill: string;
  }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { owner, repo, skill } = await params;
  return {
    title: `${skill} - ${owner}/${repo} | Skillbox`,
    description: `Try the ${skill} skill from ${owner}/${repo} in a live sandbox`,
  };
}

export default async function SkillSandboxPage({ params }: PageProps) {
  const { owner, repo, skill } = await params;

  return <SandboxPage owner={owner} repo={repo} skill={skill} />;
}
