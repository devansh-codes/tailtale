import { type AnchorHTMLAttributes, useEffect, useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

if (typeof window !== "undefined") window.addEventListener("popstate", notify);

export function navigate(to: string, state?: unknown): void {
  window.history.pushState(state ?? null, "", to);
  window.scrollTo(0, 0);
  notify();
}

export function usePath(): string {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => window.location.pathname,
  );
}

export function historyState<T>(): T | null {
  return (window.history.state as T | null) ?? null;
}

export function Link({ href, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return (
    <a
      href={href}
      {...rest}
      onClick={(e) => {
        rest.onClick?.(e);
        if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(href);
      }}
    />
  );
}

export function useTitle(title: string): void {
  useEffect(() => {
    document.title = title;
  }, [title]);
}
