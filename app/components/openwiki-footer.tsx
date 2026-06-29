import { ThemeSwitcher } from "./theme-switcher";

export function OpenWikiFooter() {
  return (
    <footer className="flex justify-center border-t bg-background px-3 py-4 text-sm text-muted-foreground">
      <ThemeSwitcher compact />
    </footer>
  );
}
