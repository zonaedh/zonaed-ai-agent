// ============================================================================
// Web App Manifest (plan §6 PWA + priority 5)
//
// Key rules honored:
//   * Icon purposes are SPLIT — separate "any" and "maskable" entries. Never
//     combine them as "any maskable" (plan §9 rule #3: iOS Safari rejects
//     combined purposes, Android requires maskable).
//   * viewport-fit=cover lives in app/layout.tsx (Viewport export).
//   * Shortcuts (New Chat / New Task / Quick Capture) target their plan
//     routes; they become live when those pages land later in the priority
//     queue (priorities 8–12).
// ============================================================================
import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Zonaed AI",
    short_name: "Zonaed",
    description: "Offline-first AI assistant PWA with synced memory, tasks, skills, and knowledge.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    lang: "en",
    background_color: "#0f172a",
    theme_color: "#0f172a",
    categories: ["productivity", "utilities"],
    icons: [
      // "any" purpose — used where the OS renders the icon inside its own mask.
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      // "maskable" purpose — full-bleed art safe inside the OS masking circle.
      { src: "/icons/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      {
        name: "New Chat",
        url: "/chat",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
      },
      {
        name: "New Task",
        url: "/tasks",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
      },
      {
        name: "Quick Capture",
        url: "/tasks?capture=1",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
      },
    ],
  };
}