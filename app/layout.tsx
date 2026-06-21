import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import PWA from "@/components/PWA";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "だれでも避難ナビ TOKYO",
  description: "ことばで状況を伝えると、あなたが行ける避難所を探す防災ナビ",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "避難ナビ" },
  icons: { apple: "/icon-192x192.png" },
};

export const viewport: Viewport = {
  themeColor: "#2563eb",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ja"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <PWA />
        {children}
      </body>
    </html>
  );
}
