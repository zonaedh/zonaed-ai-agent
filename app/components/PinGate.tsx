"use client";

// ============================================================================
// PinGate (plan §2 layer 1, §9 Priority 1 — device gate UI)
//
// Full-screen gate mounted once in the root layout. Three states:
//   * setup  — first run: choose a PIN (stored locally as a PBKDF2 hash, never
//              sent anywhere), then mint the app session token and unlock
//   * locked — every new tab session: enter the PIN to unlock
//   * open   — unlocked: renders the app children
// Children are NOT rendered while the gate is closed, so no app UI boots
// (or syncs) before the device is unlocked. After the PIN check, the app
// session token is minted best-effort: offline unlock still opens the app,
// because the data layer is local-first (Dexie).
// ============================================================================

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { isLocked, isPinSet, setPin as savePin, unlockDevice, verifyPin } from "@/lib/auth/pin";
import { getStoredSession, refreshSessionToken } from "@/lib/auth/app-session";

type Phase = "boot" | "setup" | "locked" | "open";

const MIN_PIN = 4;
const MAX_PIN = 12;
const MAX_ATTEMPTS = 5;
const COOLDOWN_MS = 30_000;

export default function PinGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>("boot");
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [offlineNote, setOfflineNote] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const [cooldownSeconds, setCooldownSeconds] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Boot: decide setup vs locked vs already-open. Fail closed — any surprise
  // while booting lands on the lock screen, never on open content.
  useEffect(() => {
    void (async () => {
      try {
        if (isLocked()) {
          setPhase((await isPinSet()) ? "locked" : "setup");
        } else {
          // Tab already unlocked (e.g. React fast refresh): keep the session
          // token fresh and stay open.
          if (!getStoredSession()) {
            try {
              await refreshSessionToken();
            } catch {
              // Offline — the local-first data layer still works.
            }
          }
          setPhase("open");
        }
      } catch {
        setPhase("locked");
      }
    })();
  }, []);

  const cooling = cooldownSeconds > 0;

  // Cooldown countdown → re-enable the form when it lapses.
  const coolingActive = cooldownSeconds > 0;
  useEffect(() => {
    if (!coolingActive) return;
    const id = setInterval(() => {
      setCooldownSeconds((s) => (s > 0 ? s - 1 : 0));
      if (cooldownSeconds <= 1) setError(null);
    }, 1000);
    return () => clearInterval(id);
  }, [coolingActive, cooldownSeconds]);

  // Focus the PIN field whenever a closed phase mounts.
  useEffect(() => {
    if (phase === "setup" || phase === "locked") inputRef.current?.focus();
  }, [phase]);

  const openGate = useCallback(async () => {
    try {
      await refreshSessionToken();
      setOfflineNote(false);
    } catch {
      setOfflineNote(true);
    }
    unlockDevice();
    setPin("");
    setConfirmPin("");
    setError(null);
    setAttempts(0);
    setPhase("open");
  }, []);

  const submitSetup = async (event: FormEvent) => {
    event.preventDefault();
    if (!/^\d{4,12}$/.test(pin)) {
      setError(`PIN must be ${MIN_PIN}–${MAX_PIN} digits.`);
      return;
    }
    if (pin !== confirmPin) {
      setError("PINs don't match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await savePin(pin);
      await openGate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not set the PIN.");
    } finally {
      setBusy(false);
    }
  };

  const submitUnlock = async (event: FormEvent) => {
    event.preventDefault();
    if (cooling || busy || pin.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      if (await verifyPin(pin)) {
        await openGate();
        return;
      }
      const next = attempts + 1;
      setAttempts(next);
      setPin("");
      if (next >= MAX_ATTEMPTS) {
        setCooldownSeconds(COOLDOWN_MS / 1000);
        setError(`Wrong PIN. Locked out for ${COOLDOWN_MS / 1000} seconds.`);
      } else {
        setError(`Wrong PIN — attempt ${next} of ${MAX_ATTEMPTS}.`);
      }
    } finally {
      setBusy(false);
    }
  };

  if (phase === "open") return <>{children}</>;

  if (phase === "boot") return null;

  const isSetup = phase === "setup";

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-zinc-50 px-4 dark:bg-zinc-950">
      <form
        onSubmit={isSetup ? submitSetup : submitUnlock}
        className="w-full max-w-xs rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
      >
        <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
          {isSetup ? "Create your PIN" : "Locked"}
        </h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          {isSetup
            ? "This PIN locks this device only. It is hashed locally and never sent to any server."
            : "Enter your PIN to unlock."}
        </p>

        <input
          ref={inputRef}
          type="password"
          inputMode="numeric"
          autoComplete="off"
          autoFocus
          disabled={busy || cooling}
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          placeholder={isSetup ? "4–12 digits" : "PIN"}
          aria-label={isSetup ? "New PIN" : "PIN"}
          className="mt-4 w-full rounded-xl border border-zinc-300 bg-white px-3 py-2 text-center text-lg tracking-[0.4em] text-zinc-900 outline-none focus:border-zinc-500 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
        />
        {isSetup && (
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            disabled={busy}
            value={confirmPin}
            onChange={(e) => setConfirmPin(e.target.value)}
            placeholder="Confirm PIN"
            aria-label="Confirm PIN"
            className="mt-2 w-full rounded-xl border border-zinc-300 bg-white px-3 py-2 text-center text-lg tracking-[0.4em] text-zinc-900 outline-none focus:border-zinc-500 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
          />
        )}

        {error && (
          <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
        {offlineNote && !isSetup && (
          <p className="mt-3 text-sm text-amber-600 dark:text-amber-400">
            Unlocked offline — will sign in when back online.
          </p>
        )}

        <button
          type="submit"
          disabled={busy || cooling || pin.length === 0 || (isSetup && confirmPin.length === 0)}
          className="mt-4 w-full rounded-xl bg-zinc-900 px-4 py-2 font-medium text-white transition hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          {busy ? "Checking…" : isSetup ? "Set PIN" : "Unlock"}
        </button>
      </form>
    </div>
  );
}