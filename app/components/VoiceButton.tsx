"use client";

// ============================================================================
// VoiceButton — mic toggle for quick capture (plan §9 item 12, nice-to-have)
//
// Wraps lib/voice/speech.ts in a small button. While listening the mic pulses
// and the hint line below the input says so. Final transcripts are cleaned
// (lib/voice cleanTranscript) before being handed to onResult, so the caller
// just sets state. Unsupported browsers show a muted, disabled mic — voice is
// a progressive enhancement, never a dependency.
// ============================================================================

import { useRef, useState } from "react";
import { speechSupported, startListening, type SpeechSession } from "@/lib/voice/speech";

export interface VoiceButtonProps {
  onResult: (transcript: string) => void;
  disabled?: boolean;
}

export default function VoiceButton({ onResult, disabled }: VoiceButtonProps) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<SpeechSession | null>(null);
  const supported = speechSupported();

  function toggle() {
    if (listening) {
      sessionRef.current?.stop();
      sessionRef.current = null;
      setListening(false);
      return;
    }
    setError(null);
    const session = startListening({
      onResult: (text) => {
        setListening(false);
        sessionRef.current = null;
        if (text) onResult(text);
      },
      onStart: () => setListening(true),
      onError: (message) => {
        setListening(false);
        sessionRef.current = null;
        setError(message);
      },
    });
    sessionRef.current = session;
    if (!session.supported) setListening(false);
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={toggle}
        disabled={disabled || !supported}
        aria-label={listening ? "Stop voice input" : "Speak a task title"}
        aria-pressed={listening}
        title={supported ? "Voice input" : "Voice input not supported in this browser"}
        className={`flex h-8 w-8 items-center justify-center rounded-full border text-base transition ${
          listening
            ? "border-red-400 bg-red-50 text-red-600 animate-pulse dark:bg-red-950/40 dark:text-red-300"
            : supported
              ? "border-zinc-300 text-zinc-500 hover:border-emerald-400 hover:text-emerald-600 dark:border-zinc-600 dark:text-zinc-400"
              : "cursor-not-allowed border-zinc-200 text-zinc-300 dark:border-zinc-800 dark:text-zinc-600"
        }`}
      >
        🎙
      </button>
      {listening && <span className="text-xs text-red-500 dark:text-red-400">Listening…</span>}
      {error && <span className="text-xs text-zinc-500 dark:text-zinc-400">{error}</span>}
    </div>
  );
}