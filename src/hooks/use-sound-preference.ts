"use client";

import { useState, useEffect, useCallback } from "react";

export type SoundPreference = "background" | "always" | "silent";

export const SOUND_PREF_KEY = "vanamti:sound_pref";
export const DEFAULT_SOUND_PREF: SoundPreference = "background";

export function useSoundPreference() {
  const [pref, setPrefState] = useState<SoundPreference>(() => {
    if (typeof window === "undefined") return DEFAULT_SOUND_PREF;
    try {
      const val = localStorage.getItem(SOUND_PREF_KEY);
      if (val === "background" || val === "always" || val === "silent") {
        return val as SoundPreference;
      }
    } catch {
      // localStorage can throw in private-browsing / sandboxed contexts.
    }
    return DEFAULT_SOUND_PREF;
  });

  const setPref = useCallback((next: SoundPreference) => {
    setPrefState(next);
    try {
      localStorage.setItem(SOUND_PREF_KEY, next);
    } catch {
      // Same private-browsing edge case as above.
    }
  }, []);

  // Sync preference between tabs in real-time
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === SOUND_PREF_KEY) {
        if (
          e.newValue === "background" ||
          e.newValue === "always" ||
          e.newValue === "silent"
        ) {
          setPrefState(e.newValue as SoundPreference);
        }
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return [pref, setPref] as const;
}
