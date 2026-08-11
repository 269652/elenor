import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Script from "next/script";
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
  title: "Hexrealms",
  description: "Settlers + Risk + Munchkin on one shared hex world.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {children}
        {/* [DEFAULT — direct request: "add this umami tracking script"] next/script with
            afterInteractive so analytics never competes with hydration/first paint — the
            behavioral equivalent of the plain `defer` attribute the snippet was given with. */}
        <Script
          src="https://cloud.umami.is/script.js"
          data-website-id="95fcc3b3-b99d-40e7-9c1b-b25567604bbb"
          strategy="afterInteractive"
        />
      </body>
    </html>
  );
}
