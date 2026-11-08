import type { Metadata } from "next";
import { preloadHints } from "@whop/elements";
import "./globals.css";
import { THEME_BOOT_SCRIPT } from "@/lib/theme";

export const metadata: Metadata = {
  title: "Build your pipeline | LOUDR Media",
  description:
    "Choose your lead volume with LOUDR Media. More leads, more conversations, more opportunity.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    // The boot script may set data-theme before React hydrates.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
        {preloadHints({ wallets: false }).map((hint) => (
          <link key={`${hint.rel}:${hint.href}`} {...hint} />
        ))}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,450;12..96,500;12..96,550;12..96,600;12..96,650;12..96,700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
