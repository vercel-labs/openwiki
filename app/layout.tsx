import type { Metadata } from "next";
import "./globals.css";
import { Analytics } from "@vercel/analytics/next";
import { Geist } from "next/font/google";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { ThemeProvider, type Theme } from "@/app/components/theme-provider";

const geist = Geist({
  subsets: ["latin"],
  variable: "--font-sans",
});

const themeCookieName = "openwiki-theme";

const themeScript = `
(() => {
  const darkBackground = "oklch(0.145 0 0)";
  const lightBackground = "oklch(1 0 0)";

  function applyTheme(theme) {
    const root = document.documentElement;
    root.classList.remove("dark", "light");
    root.classList.add(theme);
    root.dataset.openwikiThemePreference = theme;
    root.style.colorScheme = theme;
    root.style.backgroundColor = theme === "dark" ? darkBackground : lightBackground;
  }

  try {
    const match = document.cookie.match(/(?:^|; )${themeCookieName}=([^;]*)/);
    const storedTheme = match ? decodeURIComponent(match[1]) : "dark";
    const shouldUseDarkTheme =
      storedTheme !== "light" &&
      (storedTheme !== "system" || window.matchMedia("(prefers-color-scheme: dark)").matches);

    const resolvedTheme = shouldUseDarkTheme ? "dark" : "light";
    applyTheme(resolvedTheme);
    document.documentElement.dataset.openwikiThemePreference =
      storedTheme === "light" || storedTheme === "system" ? storedTheme : "dark";
  } catch {
    applyTheme("dark");
  }
})();
`;

export const metadata: Metadata = {
  title: "OpenWiki",
  description: "Generate a living, source-grounded wiki for any GitHub repository. Built on eve.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const theme: Theme = "dark";
  const htmlClassName = [geist.variable, theme].join(" ");

  return (
    <html
      data-openwiki-theme-preference={theme}
      lang="en"
      className={htmlClassName}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} id="theme-init" />
      </head>
      <body className="min-h-screen bg-background text-foreground antialiased">
        <ThemeProvider initialTheme={theme}>
          {children}
          <Analytics />
          <SpeedInsights />
        </ThemeProvider>
      </body>
    </html>
  );
}
