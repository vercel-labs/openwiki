import { getGitHubOwnerAvatarFallbackUrl } from "@/lib/github-repo-url";

export type FeaturedRepository = {
  description: string;
  fullName: string;
  repoUrl: string;
  starLabel: string;
};

export type FeaturedRepositoryCard = {
  description: string;
  fullName: string;
  iconSrc: string | null;
  repoUrl: string;
  starCount: number | null;
  starLabel?: string;
};

export const featuredRepositories: FeaturedRepository[] = [
  {
    description: "The library for web and native user interfaces.",
    fullName: "react/react",
    repoUrl: "https://github.com/react/react",
    starLabel: "246k",
  },
  {
    description: "Visual Studio Code",
    fullName: "microsoft/vscode",
    repoUrl: "https://github.com/microsoft/vscode",
    starLabel: "180k",
  },
  {
    description: "The Framework for Building Agents",
    fullName: "vercel/eve",
    repoUrl: "https://github.com/vercel/eve",
    starLabel: "1.3k",
  },
  {
    description: "A utility-first CSS framework for rapid UI development",
    fullName: "tailwindlabs/tailwindcss",
    repoUrl: "https://github.com/tailwindlabs/tailwindcss",
    starLabel: "96k",
  },
  {
    description: "The Postgres development platform",
    fullName: "supabase/supabase",
    repoUrl: "https://github.com/supabase/supabase",
    starLabel: "104k",
  },
  {
    description: "Empowering everyone to build reliable and efficient software",
    fullName: "rust-lang/rust",
    repoUrl: "https://github.com/rust-lang/rust",
    starLabel: "114k",
  },
  {
    description: "The Go programming language",
    fullName: "golang/go",
    repoUrl: "https://github.com/golang/go",
    starLabel: "135k",
  },
  {
    description: "The AI Toolkit for TypeScript",
    fullName: "vercel/ai",
    repoUrl: "https://github.com/vercel/ai",
    starLabel: "25k",
  },
  {
    description: "Model framework for modern machine learning",
    fullName: "huggingface/transformers",
    repoUrl: "https://github.com/huggingface/transformers",
    starLabel: "162k",
  },
  {
    description: "Agent engineering platform for Python",
    fullName: "langchain-ai/langchain",
    repoUrl: "https://github.com/langchain-ai/langchain",
    starLabel: "140k",
  },
  {
    description: "Official TypeScript SDK for Model Context Protocol",
    fullName: "modelcontextprotocol/typescript-sdk",
    repoUrl: "https://github.com/modelcontextprotocol/typescript-sdk",
    starLabel: "13k",
  },
  {
    description: "Production-Grade Container Scheduling and Management",
    fullName: "kubernetes/kubernetes",
    repoUrl: "https://github.com/kubernetes/kubernetes",
    starLabel: "123k",
  },
  {
    description: "React Hooks for Data Fetching",
    fullName: "vercel/swr",
    repoUrl: "https://github.com/vercel/swr",
    starLabel: "32k",
  },
  {
    description: "Open and composable observability platform",
    fullName: "grafana/grafana",
    repoUrl: "https://github.com/grafana/grafana",
    starLabel: "74k",
  },
  {
    description: "Scheduling infrastructure for absolutely everyone",
    fullName: "calcom/cal.diy",
    repoUrl: "https://github.com/calcom/cal.diy",
    starLabel: "46k",
  },
  {
    description: "The sandbox agent framework",
    fullName: "withastro/flue",
    repoUrl: "https://github.com/withastro/flue",
    starLabel: "6.8k",
  },
  {
    description: "Build system optimized for JavaScript and TypeScript",
    fullName: "vercel/turborepo",
    repoUrl: "https://github.com/vercel/turborepo",
    starLabel: "31k",
  },
  {
    description: "The modern link attribution platform",
    fullName: "dubinc/dub",
    repoUrl: "https://github.com/dubinc/dub",
    starLabel: "24k",
  },
  {
    description: "Component registry and design system tooling",
    fullName: "shadcn-ui/ui",
    repoUrl: "https://github.com/shadcn-ui/ui",
    starLabel: "118k",
  },
  {
    description: "Async state management and data fetching",
    fullName: "tanstack/query",
    repoUrl: "https://github.com/tanstack/query",
    starLabel: "50k",
  },
  {
    description: "Typesafe routing for modern web apps",
    fullName: "tanstack/router",
    repoUrl: "https://github.com/tanstack/router",
    starLabel: "15k",
  },
  {
    description: "Workshop for building and testing UI components",
    fullName: "storybookjs/storybook",
    repoUrl: "https://github.com/storybookjs/storybook",
    starLabel: "90k",
  },
  {
    description: "The web framework for content-driven websites",
    fullName: "withastro/astro",
    repoUrl: "https://github.com/withastro/astro",
    starLabel: "61k",
  },
  {
    description: "A framework for building confident web apps",
    fullName: "angular/angular",
    repoUrl: "https://github.com/angular/angular",
    starLabel: "100k",
  },
  {
    description: "Formatter, linter, CLI, and language server for web projects",
    fullName: "biomejs/biome",
    repoUrl: "https://github.com/biomejs/biome",
    starLabel: "25k",
  },
  {
    description: "End-to-end typesafe APIs for TypeScript apps",
    fullName: "trpc/trpc",
    repoUrl: "https://github.com/trpc/trpc",
    starLabel: "40k",
  },
  {
    description: "Data framework for agents and retrieval-augmented generation",
    fullName: "run-llama/llama_index",
    repoUrl: "https://github.com/run-llama/llama_index",
    starLabel: "50k",
  },
  {
    description: "Official JavaScript and TypeScript library for the OpenAI API",
    fullName: "openai/openai-node",
    repoUrl: "https://github.com/openai/openai-node",
    starLabel: "11k",
  },
  {
    description: "TypeScript SDK for Anthropic's model APIs",
    fullName: "anthropics/anthropic-sdk-typescript",
    repoUrl: "https://github.com/anthropics/anthropic-sdk-typescript",
    starLabel: "2k",
  },
  {
    description: "Universal native apps with React",
    fullName: "expo/expo",
    repoUrl: "https://github.com/expo/expo",
    starLabel: "50k",
  },
  {
    description: "The web framework for perfectionists with deadlines",
    fullName: "django/django",
    repoUrl: "https://github.com/django/django",
    starLabel: "88k",
  },
  {
    description: "Full-stack web application framework for Ruby",
    fullName: "rails/rails",
    repoUrl: "https://github.com/rails/rails",
    starLabel: "59k",
  },
  {
    description: "Platform to author, schedule, and monitor workflows",
    fullName: "apache/airflow",
    repoUrl: "https://github.com/apache/airflow",
    starLabel: "46k",
  },
  {
    description: "Real-time analytics database",
    fullName: "clickhouse/clickhouse",
    repoUrl: "https://github.com/ClickHouse/ClickHouse",
    starLabel: "48k",
  },
  {
    description: "Living documentation for your codebase",
    fullName: "vercel-labs/openwiki",
    repoUrl: "https://github.com/vercel-labs/openwiki",
    starLabel: "0",
  },
];

const featuredRepositoryFullNames = new Set(
  featuredRepositories.map((repository) => repository.fullName.toLowerCase()),
);

export function isFeaturedRepositoryFullName(fullName: string): boolean {
  return featuredRepositoryFullNames.has(fullName.toLowerCase());
}

export function getStaticFeaturedRepositoryCards(): FeaturedRepositoryCard[] {
  return featuredRepositories.map((repository) => ({
    description: repository.description,
    fullName: repository.fullName,
    iconSrc: getGitHubOwnerAvatarFallbackUrl(repository.fullName.split("/")[0] ?? ""),
    repoUrl: repository.repoUrl,
    starCount: null,
    starLabel: repository.starLabel,
  }));
}
