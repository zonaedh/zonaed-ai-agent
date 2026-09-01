// ============================================================================
// PIN device gate (plan §2 layer 1)
//
// The PIN is purely a local "is this physically the right person's device"
// check. Rules enforced here:
//   * Never stored or committed in plaintext — we store only a PBKDF2-SHA256
//     hash, salted per device, in IndexedDB (via localStorage-free storage).
//   * Never sent to any AI provider or to Supabase — the PIN never leaves the
//     device. Supabase Auth (§2 layer 2) is the actual data authorization.
// ============================================================================

const PBKDF2_ITERATIONS = 310_000;
const SALT_KEY = "zonaed.pin.salt";
const HASH_KEY = "zonaed.pin.hash";

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function hashPin(pin: string, salt: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(pin),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: encoder.encode(salt),
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    256,
  );
  return Array.from(new Uint8Array(bits), (b) => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function isPinSet(): Promise<boolean> {
  return typeof localStorage !== "undefined" && localStorage.getItem(HASH_KEY) !== null;
}

/** First-run setup: stores salt + PBKDF2 hash. The plaintext PIN is discarded immediately. */
export async function setPin(pin: string): Promise<void> {
  if (pin.length < 4) {
    throw new Error("PIN must be at least 4 characters");
  }
  const salt = randomHex(16);
  const hash = await hashPin(pin, salt);
  localStorage.setItem(SALT_KEY, salt);
  localStorage.setItem(HASH_KEY, hash);
}

/** Verify a PIN attempt against the stored hash. */
export async function verifyPin(pin: string): Promise<boolean> {
  const salt = localStorage.getItem(SALT_KEY);
  const stored = localStorage.getItem(HASH_KEY);
  if (!salt || !stored) return false;
  const candidate = await hashPin(pin, salt);
  return constantTimeEqual(candidate, stored);
}

/** Change PIN: re-hash under a fresh salt. */
export async function changePin(currentPin: string, newPin: string): Promise<boolean> {
  if (!(await verifyPin(currentPin))) return false;
  await setPin(newPin);
  return true;
}

/** Clears the gate (locks the device). Does NOT touch the Supabase session. */
export function lockDevice(): void {
  sessionStorage.setItem("zonaed.locked", "1");
}

export function unlockDevice(): void {
  sessionStorage.removeItem("zonaed.locked");
}

export function isLocked(): boolean {
  return typeof sessionStorage !== "undefined" && sessionStorage.getItem("zonaed.locked") === "1";
}
