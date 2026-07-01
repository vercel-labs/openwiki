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
    description: "Framework for Web Testing and Automation",
    fullName: "microsoft/playwright",
    repoUrl: "https://github.com/microsoft/playwright",
    starLabel: "91k",
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
    description: "Node.js JavaScript runtime",
    fullName: "nodejs/node",
    repoUrl: "https://github.com/nodejs/node",
    starLabel: "118k",
  },
  {
    description: "The React Framework",
    fullName: "vercel/next.js",
    repoUrl: "https://github.com/vercel/next.js",
    starLabel: "140k",
  },
  {
    description: "The Go programming language",
    fullName: "golang/go",
    repoUrl: "https://github.com/golang/go",
    starLabel: "135k",
  },
  {
    description: "The Python programming language",
    fullName: "python/cpython",
    repoUrl: "https://github.com/python/cpython",
    starLabel: "73k",
  },
  {
    description: "A modern runtime for JavaScript and TypeScript",
    fullName: "denoland/deno",
    repoUrl: "https://github.com/denoland/deno",
    starLabel: "107k",
  },
  {
    description: "Next generation frontend tooling",
    fullName: "vitejs/vite",
    repoUrl: "https://github.com/vitejs/vite",
    starLabel: "82k",
  },
  {
    description: "The progressive JavaScript framework",
    fullName: "vuejs/core",
    repoUrl: "https://github.com/vuejs/core",
    starLabel: "54k",
  },
  {
    description: "Web development for the rest of us",
    fullName: "sveltejs/svelte",
    repoUrl: "https://github.com/sveltejs/svelte",
    starLabel: "87k",
  },
  {
    description: "Declarative routing for React",
    fullName: "remix-run/react-router",
    repoUrl: "https://github.com/remix-run/react-router",
    starLabel: "56k",
  },
  {
    description: "Next-generation ORM for Node.js and TypeScript",
    fullName: "prisma/prisma",
    repoUrl: "https://github.com/prisma/prisma",
    starLabel: "46k",
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
    description: "Minimal GPT training and finetuning implementation",
    fullName: "karpathy/nanoGPT",
    repoUrl: "https://github.com/karpathy/nanoGPT",
    starLabel: "60k",
  },
  {
    description: "Official Python library for the OpenAI API",
    fullName: "openai/openai-python",
    repoUrl: "https://github.com/openai/openai-python",
    starLabel: "31k",
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
    description: "The full-stack Vue framework",
    fullName: "nuxt/nuxt",
    repoUrl: "https://github.com/nuxt/nuxt",
    starLabel: "61k",
  },
  {
    description: "A framework for building confident web apps",
    fullName: "angular/angular",
    repoUrl: "https://github.com/angular/angular",
    starLabel: "100k",
  },
  {
    description: "JavaScript runtime, bundler, test runner, and package manager",
    fullName: "oven-sh/bun",
    repoUrl: "https://github.com/oven-sh/bun",
    starLabel: "93k",
  },
  {
    description: "Fast, disk space efficient package manager",
    fullName: "pnpm/pnpm",
    repoUrl: "https://github.com/pnpm/pnpm",
    starLabel: "36k",
  },
  {
    description: "Formatter, linter, CLI, and language server for web projects",
    fullName: "biomejs/biome",
    repoUrl: "https://github.com/biomejs/biome",
    starLabel: "25k",
  },
  {
    description: "Fast Python package and project manager",
    fullName: "astral-sh/uv",
    repoUrl: "https://github.com/astral-sh/uv",
    starLabel: "87k",
  },
  {
    description: "Build cross-platform desktop apps with web technologies",
    fullName: "electron/electron",
    repoUrl: "https://github.com/electron/electron",
    starLabel: "122k",
  },
  {
    description: "Secure desktop and mobile apps with a web frontend",
    fullName: "tauri-apps/tauri",
    repoUrl: "https://github.com/tauri-apps/tauri",
    starLabel: "108k",
  },
  {
    description: "Enterprise-grade server-side applications with TypeScript",
    fullName: "nestjs/nest",
    repoUrl: "https://github.com/nestjs/nest",
    starLabel: "76k",
  },
  {
    description: "End-to-end typesafe APIs for TypeScript apps",
    fullName: "trpc/trpc",
    repoUrl: "https://github.com/trpc/trpc",
    starLabel: "40k",
  },
  {
    description: "TypeScript ORM and SQL toolkit",
    fullName: "drizzle-team/drizzle-orm",
    repoUrl: "https://github.com/drizzle-team/drizzle-orm",
    starLabel: "35k",
  },
  {
    description: "Run large language models locally",
    fullName: "ollama/ollama",
    repoUrl: "https://github.com/ollama/ollama",
    starLabel: "175k",
  },
  {
    description: "LLM inference in C and C++",
    fullName: "ggml-org/llama.cpp",
    repoUrl: "https://github.com/ggml-org/llama.cpp",
    starLabel: "118k",
  },
  {
    description: "High-throughput inference and serving engine for LLMs",
    fullName: "vllm-project/vllm",
    repoUrl: "https://github.com/vllm-project/vllm",
    starLabel: "85k",
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
    description: "TypeScript-first schema validation",
    fullName: "colinhacks/zod",
    repoUrl: "https://github.com/colinhacks/zod",
    starLabel: "43k",
  },
  {
    description: "Accessible primitives for high-quality design systems",
    fullName: "radix-ui/primitives",
    repoUrl: "https://github.com/radix-ui/primitives",
    starLabel: "19k",
  },
  {
    description: "Comprehensive React component library",
    fullName: "mui/material-ui",
    repoUrl: "https://github.com/mui/material-ui",
    starLabel: "98k",
  },
  {
    description: "Universal native apps with React",
    fullName: "expo/expo",
    repoUrl: "https://github.com/expo/expo",
    starLabel: "50k",
  },
  {
    description: "Open-source full-stack Next.js framework",
    fullName: "payloadcms/payload",
    repoUrl: "https://github.com/payloadcms/payload",
    starLabel: "43k",
  },
  {
    description: "SDK and tooling for Cloudflare Workers",
    fullName: "cloudflare/workers-sdk",
    repoUrl: "https://github.com/cloudflare/workers-sdk",
    starLabel: "4.2k",
  },
  {
    description: "Node.js library for the Stripe API",
    fullName: "stripe/stripe-node",
    repoUrl: "https://github.com/stripe/stripe-node",
    starLabel: "4.5k",
  },
  {
    description: "Build headless Shopify storefronts",
    fullName: "shopify/hydrogen",
    repoUrl: "https://github.com/Shopify/hydrogen",
    starLabel: "2k",
  },
  {
    description: "Web framework built on web standards",
    fullName: "honojs/hono",
    repoUrl: "https://github.com/honojs/hono",
    starLabel: "31k",
  },
  {
    description: "Next generation testing framework powered by Vite",
    fullName: "vitest-dev/vitest",
    repoUrl: "https://github.com/vitest-dev/vitest",
    starLabel: "17k",
  },
  {
    description: "High-performance Python API framework",
    fullName: "fastapi/fastapi",
    repoUrl: "https://github.com/fastapi/fastapi",
    starLabel: "100k",
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
    description: "Analytics engineering transformation workflow",
    fullName: "dbt-labs/dbt-core",
    repoUrl: "https://github.com/dbt-labs/dbt-core",
    starLabel: "13k",
  },
  {
    description: "Infrastructure as code",
    fullName: "hashicorp/terraform",
    repoUrl: "https://github.com/hashicorp/terraform",
    starLabel: "49k",
  },
  {
    description: "Monitoring system and time series database",
    fullName: "prometheus/prometheus",
    repoUrl: "https://github.com/prometheus/prometheus",
    starLabel: "65k",
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
