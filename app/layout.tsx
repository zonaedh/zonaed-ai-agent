import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import SyncIndicator from "./components/SyncIndicator";
import PwaLinks from "./components/PwaLinks";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Zonaed AI",
  description: "Offline-first AI assistant PWA with synced memory, tasks, and knowledge.",
  applicationName: "Zonaed AI",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Zonaed AI",
  },
  icons: {
    icon: "/icons/icon-192.png",
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

/**
 * viewport-fit=cover (plan §9 priority 5 / §8 manual check #2): the app draws
 * edge-to-edge past the notch and home indicator; content pages use the
 * .ios-safe-* utilities in globals.css to clear the insets.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0f172a",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col ios-safe-top">
        <PwaLinks />
        {children}
        <SyncIndicator />
      </body>
    </html>
  );
}

