'use client';

/**
 * [DEFAULT — direct request: "implement custom events for umami so we can track when a user
 * starts a new game, wins, loses or quits a running game"] Thin wrapper around the global
 * `window.umami.track(...)` the Umami script tag (app/layout.tsx) attaches once it loads.
 *
 * Every call site is already a 'use client' module, so the SSR guard below matches the existing
 * `typeof window === 'undefined'` style used by lib/hotseatPersistence.ts and
 * lib/webrtc/persistence.ts — extended here to also cover "the script hasn't loaded yet" (it's
 * `strategy="afterInteractive"`, so there's a real window during which `window.umami` isn't
 * defined yet), "this is an itch.io build" (app/layout.tsx skips the script tag entirely there),
 * and "an ad-blocker ate the request" — every one of those makes a tracking call a silent no-op
 * instead of a thrown error.
 */

type UmamiEventData = Record<string, string | number | boolean | null>;

declare global {
  interface Window {
    umami?: {
      track: (eventName: string, eventData?: UmamiEventData) => void;
    };
  }
}

export function trackEvent(eventName: string, eventData?: UmamiEventData): void {
  if (typeof window === 'undefined' || !window.umami) return;
  window.umami.track(eventName, eventData);
}
