"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect } from "react";
import { useThemePreference, type Theme } from "@/app/components/theme-provider";
import { Button } from "@/components/ui/button";

const themeCookieName = "openwiki-theme";
const themeCookieMaxAge = 60 * 60 * 24 * 365;
const themeOptions: Array<{
  icon: typeof Moon;
  label: string;
  value: Theme;
}> = [
  { icon: Moon, label: "Dark", value: "dark" },
  { icon: Sun, label: "Light", value: "light" },
  { icon: Monitor, label: "System", value: "system" },
];

export function ThemeSwitcher({ compact = false }: { compact?: boolean }) {
  const { setTheme, theme } = useThemePreference();

  useEffect(() => {
    const storedTheme = readStoredTheme();
    applyTheme(storedTheme);
    setTheme(storedTheme);

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const onSystemThemeChange = () => {
      if (readStoredTheme() === "system") {
        applyTheme("system");
      }
    };
    mediaQuery.addEventListener("change", onSystemThemeChange);
    return () => mediaQuery.removeEventListener("change", onSystemThemeChange);
  }, []);

  function onSelectTheme(nextTheme: Theme) {
    writeThemeCookie(nextTheme);
    applyTheme(nextTheme);
    setTheme(nextTheme);
  }

  return (
    <div aria-label="Theme" className="flex items-center rounded-md border bg-background p-0.5" role="group">
      {themeOptions.map((option) => {
        const Icon = option.icon;
        const isSelected = option.value === theme;
        return (
          <Button
            aria-label={`Use ${option.label.toLowerCase()} theme`}
            aria-pressed={isSelected}
            className="text-muted-foreground"
            data-openwiki-theme-option={option.value}
            key={option.value}
            onClick={() => onSelectTheme(option.value)}
            size={compact ? "icon-xs" : "xs"}
            title={option.label}
            type="button"
            variant="ghost"
          >
            <Icon aria-hidden="true" />
            {compact ? null : <span>{option.label}</span>}
          </Button>
        );
      })}
    </div>
  );
}

function readStoredTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  const value = document.cookie
    .split("; ")
    .find((cookie) => cookie.startsWith(`${themeCookieName}=`))
    ?.split("=")[1];
  if (value === undefined) return "dark";
  const decoded = decodeURIComponent(value);
  return decoded === "light" || decoded === "system" ? decoded : "dark";
}

function writeThemeCookie(theme: Theme) {
  document.cookie = `${themeCookieName}=${encodeURIComponent(theme)}; Path=/; Max-Age=${themeCookieMaxAge}; SameSite=Lax`;
}

function applyTheme(theme: Theme) {
  const shouldUseDarkTheme =
    theme === "dark" ||
    (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  const resolvedTheme = shouldUseDarkTheme ? "dark" : "light";
  const root = document.documentElement;

  root.classList.remove("dark", "light");
  root.classList.add(resolvedTheme);
  root.dataset.openwikiThemePreference = theme;
  root.style.colorScheme = resolvedTheme;
  root.style.backgroundColor = shouldUseDarkTheme ? "oklch(0.145 0 0)" : "oklch(1 0 0)";
}
