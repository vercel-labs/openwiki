import { type ReactNode } from "react";
import { MarkdownAsync } from "react-markdown";
import rehypePrettyCode, { type Options as PrettyCodeOptions } from "rehype-pretty-code";
import remarkGfm from "remark-gfm";
import { getRepoHref } from "@/lib/github-repo-url";
import { markdownClassName } from "./markdown-class-name";

type WikiMarkdownProps = {
  commitSha: string | null;
  markdown: string;
  owner: string;
  repoName: string;
};

const prettyCodeOptions: PrettyCodeOptions = {
  defaultLang: "plaintext",
  keepBackground: false,
  theme: {
    dark: "github-dark",
    light: "github-light",
  },
};

export async function WikiMarkdown({ commitSha, markdown, owner, repoName }: WikiMarkdownProps) {
  const repoBasePath = getRepoHref({ name: repoName, owner });
  const headingIds = new Map<string, number>();
  const getHeadingId = (children: ReactNode): string => {
    const baseId = slugifyHeading(textFromChildren(children));
    const count = headingIds.get(baseId) ?? 0;
    headingIds.set(baseId, count + 1);
    return count === 0 ? baseId : `${baseId}-${count + 1}`;
  };

  const renderedMarkdown = await MarkdownAsync({
    children: markdown,
    components: {
      a: ({ children, href, title }) => {
        const safeHref = href === undefined ? null : transformMarkdownHref(href, repoBasePath);
        if (safeHref === null) {
          return <>{children}</>;
        }

        const isExternal = /^https?:/i.test(safeHref);
        return (
          <a
            href={safeHref}
            rel={isExternal ? "noreferrer" : undefined}
            target={isExternal ? "_blank" : undefined}
            title={title}
          >
            {children}
          </a>
        );
      },
      h2: ({ children }) => <h2 id={getHeadingId(children)}>{children}</h2>,
      h3: ({ children }) => <h3 id={getHeadingId(children)}>{children}</h3>,
      img: ({ alt, src, title }) => {
        const safeSrc = typeof src !== "string"
          ? null
          : transformMarkdownImageSrc(src, { commitSha, owner, repoName });
        if (safeSrc === null) return null;

        return (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            alt={alt ?? ""}
            loading="lazy"
            src={safeSrc}
            title={title}
          />
        );
      },
    },
    rehypePlugins: [[rehypePrettyCode, prettyCodeOptions]],
    remarkPlugins: [remarkGfm],
    skipHtml: true,
  });

  return (
    <div className={markdownClassName}>
      {renderedMarkdown}
    </div>
  );
}

function textFromChildren(children: ReactNode): string {
  if (children === null || children === undefined || typeof children === "boolean") return "";
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(textFromChildren).join("");
  if (typeof children === "object" && "props" in children) {
    return textFromChildren((children as { props?: { children?: ReactNode } }).props?.children);
  }
  return "";
}

function slugifyHeading(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length === 0 ? "section" : slug;
}

function transformMarkdownImageSrc(
  url: string,
  repository: {
    commitSha: string | null;
    owner: string;
    repoName: string;
  },
): string | null {
  const trimmed = url.trim();
  if (/^https:/i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      return parsed.hostname === "raw.githubusercontent.com" ? parsed.toString() : null;
    } catch {
      return null;
    }
  }
  if (/^(http:|data:)/i.test(trimmed)) return null;
  if (trimmed.includes("://")) return null;

  const normalized = trimmed
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");
  if (
    normalized.length === 0 ||
    normalized.startsWith("../") ||
    !/^[A-Za-z0-9][A-Za-z0-9._~/-]*(#[A-Za-z0-9._~-]+)?$/.test(normalized)
  ) {
    return null;
  }

  const ref = repository.commitSha ?? "main";
  return `https://raw.githubusercontent.com/${repository.owner}/${repository.repoName}/${ref}/${normalized}`;
}

function transformMarkdownHref(url: string, repoBasePath: string): string | null {
  const trimmed = url.trim();
  if (trimmed.startsWith("#")) return trimmed;
  if (/^(https?:|mailto:|tel:)/i.test(trimmed)) return trimmed;
  if (trimmed.startsWith("/")) return trimmed;

  const normalized = trimmed.replace(/^\.\//, "");
  if (
    normalized.length === 0 ||
    normalized.startsWith("../") ||
    normalized.includes("://") ||
    !/^[A-Za-z0-9][A-Za-z0-9._~/-]*(#[A-Za-z0-9._~-]+)?$/.test(normalized)
  ) {
    return null;
  }

  const [slug, hash] = normalized.split("#", 2);
  const href = slug === "overview" ? repoBasePath : `${repoBasePath}/${slug}`;
  return hash === undefined ? href : `${href}#${hash}`;
}
