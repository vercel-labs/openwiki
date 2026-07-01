"use client";

import type { MouseEvent, ReactNode } from "react";
import { useCallback, useState } from "react";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

type MobileWikiNavProps = {
  children: ReactNode;
};

export function MobileWikiNav({ children }: MobileWikiNavProps) {
  const [open, setOpen] = useState(false);

  const handleNavClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest("a") !== null) {
      setOpen(false);
    }
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button aria-label="Open wiki pages" size="icon-sm" type="button" variant="outline">
          <Menu className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent
        className="top-0 left-0 h-dvh w-[min(88vw,360px)] max-w-none translate-x-0 translate-y-0 gap-0 rounded-none border-r bg-background p-0 shadow-xl sm:max-w-[360px]"
        showCloseButton
      >
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex h-10 shrink-0 items-center border-b px-4 pr-12">
            <DialogTitle className="text-sm">Wiki pages</DialogTitle>
            <DialogDescription className="sr-only">
              Navigate between wiki pages for this repository.
            </DialogDescription>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4" onClick={handleNavClick}>
            {children}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
