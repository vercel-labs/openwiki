"use client";

import { useEffect, useRef, useState } from "react";
import { Copy } from "lucide-react";
import { Button } from "@/components/ui/button";

type CopyMarkdownButtonProps = {
  markdown: string;
};

export function CopyMarkdownButton({ markdown }: CopyMarkdownButtonProps) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  async function copyMarkdown() {
    await writeClipboardText(markdown);
    setCopied(true);

    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
    }

    timeoutRef.current = setTimeout(() => {
      setCopied(false);
      timeoutRef.current = null;
    }, 1600);
  }

  return (
    <Button
      className="mt-4 w-fit justify-start gap-2 rounded-md px-2 text-muted-foreground hover:text-foreground"
      onClick={() => {
        void copyMarkdown();
      }}
      size="sm"
      type="button"
      variant="outline"
    >
      <Copy aria-hidden="true" className="h-3.5 w-3.5" />
      <span aria-live="polite">{copied ? "Copied!" : "Copy markdown"}</span>
    </Button>
  );
}

async function writeClipboardText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText !== undefined) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();

  try {
    const copied = document.execCommand("copy");
    if (!copied) {
      throw new Error("Copy command was not accepted.");
    }
  } finally {
    document.body.removeChild(textarea);
  }
}
