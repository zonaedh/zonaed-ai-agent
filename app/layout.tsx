import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import SyncIndicator from "./components/SyncIndicator";
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
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {children}
        <SyncIndicator />
      </body>
    </html>
  );
}

