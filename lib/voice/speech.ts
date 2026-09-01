// ============================================================================
// Web Speech API wrapper — voice quick-capture (plan §9 item 12, nice-to-have)
//
// Client-only feature (browser SpeechRecognition). Two layers:
//
//   * speechSupported() — feature detect with a `windowLike` seam so the pure
//     detection is testable offline (verify-nice.mts passes a fake global).
//   * startListening() — builds a typed adapter over
//     SpeechRecognition/webkitSpeechRecognition (lang en-US, interim results
//     on), wires result/error/end, and returns a stop() that cleans up.
//
// The SpeechRecognition API is a progressive enhancement: every browser that
// lacks it simply renders the disabled mic in VoiceButton. Nothing here
// throws when the API is absent.
// ============================================================================

export type SpeechRecognitionEngine = {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  continuous: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

export type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: {
      isFinal: boolean;
      [altIndex: number]: { transcript: string };
    };
  };
};

export interface StartListeningOptions {
  /** One-shot final transcript. Fired with "" if only silence/interim. */
  onResult: (text: string) => void;
  onStart?: () => void;
  onError?: (message: string) => void;
  lang?: string;
}

/**
 * Feature detection. `windowLike` is injectable for offline tests; defaults
 * to the real global (absent in Node, so servers never see this as supported).
 */
export function speechSupported(
  windowLike: unknown = typeof window !== "undefined" ? window : undefined,
): boolean {
  if (!windowLike) return false;
  const w = windowLike as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
  return Boolean(w.SpeechRecognition || w.webkitSpeechRecognition);
}

/** Find the constructor available in this browser, or null. */
function engineCtor(
  windowLike: unknown = typeof window !== "undefined" ? window : undefined,
): (new () => SpeechRecognitionEngine) | null {
  if (!windowLike) return null;
  const w = windowLike as {
    SpeechRecognition?: new () => SpeechRecognitionEngine;
    webkitSpeechRecognition?: new () => SpeechRecognitionEngine;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * Collapse whitespace + capitalize first letter. Pure, tested, and applied to
 * every final transcript before it is handed to the consumer.
 */
export function cleanTranscript(raw: string): string {
  const single = raw.replace(/\s+/g, " ").trim();
  if (!single) return "";
  return single[0].toUpperCase() + single.slice(1);
}

export interface SpeechSession {
  supported: boolean;
  /** Stop listening (safe no-op when unsupported/stopped). */
  stop: () => void;
}

/** Start a listening session. Returns an early-stop handle. */
export function startListening(
  options: StartListeningOptions,
  windowLike: unknown = typeof window !== "undefined" ? window : undefined,
): SpeechSession {
  const ctor = engineCtor(windowLike);
  if (!ctor) {
    options.onError?.("Voice input is not supported in this browser.");
    return { supported: false, stop: () => {} };
  }

  const recognition = new ctor();
  recognition.lang = options.lang ?? "en-US";
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;
  recognition.continuous = false;

  let finalText = "";

  recognition.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) {
        finalText = cleanTranscript(result[0]?.transcript ?? "");
      }
    }
  };

  recognition.onerror = (event) => {
    // "no-speech" is not worth surfacing as an error — emit empty result.
    if (event.error === "no-speech") {
      options.onResult("");
      return;
    }
    options.onError?.(event.error ?? "Speech recognition failed");
  };

  recognition.onend = () => {
    options.onResult(finalText);
    finalText = "";
  };

  try {
    recognition.start();
    options.onStart?.();
  } catch {
    options.onError?.("Could not start speech recognition.");
  }

  return { supported: true, stop: () => recognition.abort() };
}