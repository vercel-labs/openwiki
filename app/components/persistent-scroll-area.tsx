"use client";

import { usePathname } from "next/navigation";
import {
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useRef,
} from "react";

type PersistentScrollAreaProps = {
  ariaLabel: string;
  children: ReactNode;
  className?: string;
  storageKey: string;
};

export function PersistentScrollArea({
  ariaLabel,
  children,
  className,
  storageKey,
}: PersistentScrollAreaProps) {
  const pathname = usePathname();
  const elementRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (element === null) return;

    const storedScrollTop = window.sessionStorage.getItem(storageKey);
    if (storedScrollTop === null) return;

    const scrollTop = Number(storedScrollTop);
    if (!Number.isFinite(scrollTop)) return;

    element.scrollTop = scrollTop;
    const animationFrame = window.requestAnimationFrame(() => {
      element.scrollTop = scrollTop;
    });

    return () => window.cancelAnimationFrame(animationFrame);
  }, [pathname, storageKey]);

  const handleScroll = useCallback(() => {
    const element = elementRef.current;
    if (element === null) return;

    window.sessionStorage.setItem(storageKey, String(element.scrollTop));
  }, [storageKey]);

  return (
    <aside
      aria-label={ariaLabel}
      className={className}
      onScroll={handleScroll}
      ref={elementRef}
    >
      {children}
    </aside>
  );
}
