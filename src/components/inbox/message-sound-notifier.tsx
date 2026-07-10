"use client";

import { useEffect, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { useSoundPreference } from "@/hooks/use-sound-preference";
import { playNotificationChime } from "@/lib/sound";
import type { Message } from "@/types";

export function MessageSoundNotifier() {
  const [soundPref] = useSoundPreference();
  // Keep latest sound preference in a ref to avoid recreating the realtime channel
  // and causing quick disconnects/reconnects on every render/state sync.
  const prefRef = useRef(soundPref);

  useEffect(() => {
    prefRef.current = soundPref;
  }, [soundPref]);

  useEffect(() => {
    const supabase = createClient();

    const channel = supabase
      .channel("global-message-sounds")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages" },
        (payload) => {
          const newMsg = payload.new as Message;

          // Only care about incoming messages from customers
          if (newMsg.sender_type !== "customer") return;

          const currentPref = prefRef.current;
          if (currentPref === "silent") return;

          if (currentPref === "background") {
            // Check if the document/tab is hidden OR if the window is not focused
            const isTabHidden = document.visibilityState !== "visible";
            const isTabBlurred = !document.hasFocus();

            if (isTabHidden || isTabBlurred) {
              playNotificationChime();
            }
          } else if (currentPref === "always") {
            playNotificationChime();
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  return null;
}
