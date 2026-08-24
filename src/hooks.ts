import { useEffect, useRef, useCallback } from 'react';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useFocusTrap(active: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const prevFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;
    prevFocus.current = document.activeElement as HTMLElement;
    const el = ref.current;
    if (!el) return;
    // Focus first focusable element inside
    const first = el.querySelector(FOCUSABLE) as HTMLElement | null;
    first?.focus();

    function handleKey(e: KeyboardEvent) {
      if (e.key !== 'Tab') return;
      const focusables = Array.from(el!.querySelectorAll(FOCUSABLE)) as HTMLElement[];
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    el.addEventListener('keydown', handleKey);
    return () => {
      el.removeEventListener('keydown', handleKey);
      prevFocus.current?.focus();
    };
  }, [active]);

  return ref;
}

// Escape key handler
export function useEscapeKey(handler: () => void, active = true) {
  useEffect(() => {
    if (!active) return;
    const fn = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handler();
    };
    document.addEventListener('keydown', fn);
    return () => document.removeEventListener('keydown', fn);
  }, [handler, active]);
}

// Arrow key navigation for list items
export function useArrowNav(containerRef: React.RefObject<HTMLElement | null>, selector: string) {
  const handleKey = useCallback((e: KeyboardEvent) => {
    const container = containerRef.current;
    if (!container) return;
    const items = Array.from(container.querySelectorAll(selector)) as HTMLElement[];
    const idx = items.indexOf(document.activeElement as HTMLElement);
    if (idx === -1) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault();
      items[Math.min(idx + 1, items.length - 1)]?.focus();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      items[Math.max(idx - 1, 0)]?.focus();
    }
  }, [containerRef, selector]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.addEventListener('keydown', handleKey);
    return () => container.removeEventListener('keydown', handleKey);
  }, [containerRef, handleKey]);
}

// Live region announcer for screen readers
export function announce(message: string) {
  let el = document.getElementById('sr-announcer');
  if (!el) {
    el = document.createElement('div');
    el.id = 'sr-announcer';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.setAttribute('aria-atomic', 'true');
    el.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;';
    document.body.appendChild(el);
  }
  el.textContent = message;
}
