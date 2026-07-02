import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

export const openWikiOgSize = {
  width: 1200,
  height: 630,
};

export const openWikiOgContentType = "image/png";

type OpenWikiOgImageInput = {
  pageTitle?: string;
  repoLabel?: string;
};

let geistFontPromise: Promise<Buffer> | undefined;
const wordmarkOffsets = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [0, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
] as const;

export async function createOpenWikiOgImage({
  pageTitle,
  repoLabel,
}: OpenWikiOgImageInput = {}) {
  return new ImageResponse(
    (
      <div
        style={{
          background: "#1a1a1a",
          color: "#ffffff",
          display: "flex",
          fontFamily: "Geist, Arial, sans-serif",
          height: "100%",
          overflow: "hidden",
          position: "relative",
          width: "100%",
        }}
      >
        <svg
          aria-hidden="true"
          height={openWikiOgSize.height}
          style={{ position: "absolute", inset: 0 }}
          viewBox={`0 0 ${openWikiOgSize.width} ${openWikiOgSize.height}`}
          width={openWikiOgSize.width}
        >
          <rect width="1200" height="630" fill="#1a1a1a" />
          <path d="M52 96 L76 54 L100 96 Z" fill="#fff" />

          <path d="M0 512 H1200" stroke="#666" strokeWidth="2" />
          <path d="M800 0 V512" stroke="#666" strokeWidth="2" />
          <path d="M1000 0 V512" stroke="#666" strokeWidth="2" />

          <path
            d="M800 100 H945 C982 100 1000 124 1000 156 V512"
            fill="none"
            stroke="#666"
            strokeWidth="2"
          />
          <path
            d="M1200 100 H1055 C1018 100 1000 124 1000 156 V512"
            fill="none"
            stroke="#666"
            strokeWidth="2"
          />
          <path
            d="M800 400 H945 C982 400 1000 424 1000 456 V512"
            fill="none"
            stroke="#666"
            strokeWidth="2"
          />
          <path
            d="M1200 400 H1055 C1018 400 1000 424 1000 456 V512"
            fill="none"
            stroke="#666"
            strokeWidth="2"
          />

          <path d="M1088 72 V128 M1060 100 H1116" stroke="#fff" strokeWidth="2" />
        </svg>

        {wordmarkOffsets.map(([x, y]) => (
          <div
            key={`${x}:${y}`}
            style={{
              color: "#fff",
              display: "flex",
              fontSize: 100,
              fontWeight: 600,
              left: 52 + x,
              letterSpacing: "-4px",
              lineHeight: "1",
              position: "absolute",
              top: 274 + y,
              whiteSpace: "nowrap",
            }}
          >
            OpenWiki
          </div>
        ))}

        {pageTitle || repoLabel ? (
          <div
            style={{
              bottom: 42,
              display: "flex",
              flexDirection: "row",
              gap: 18,
              left: 52,
              lineHeight: "1.1",
              maxWidth: 760,
              position: "absolute",
              whiteSpace: "nowrap",
            }}
          >
            {pageTitle ? (
              <div
                style={{
                  color: "#fff",
                  fontSize: 38,
                  fontWeight: 500,
                }}
              >
                {truncateOgText(pageTitle, 36)}
              </div>
            ) : null}
            {repoLabel ? (
              <div
                style={{
                  color: "#9b9b9b",
                  fontSize: 38,
                  fontWeight: 500,
                }}
              >
                {truncateOgText(repoLabel, 32)}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    ),
    {
      ...openWikiOgSize,
      fonts: [
        {
          data: await getGeistFont(),
          name: "Geist",
          style: "normal",
          weight: 600,
        },
      ],
    },
  );
}

function getGeistFont(): Promise<Buffer> {
  geistFontPromise ??= readFile(
    join(
      process.cwd(),
      "node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf",
    ),
  );

  return geistFontPromise;
}

function truncateOgText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}
