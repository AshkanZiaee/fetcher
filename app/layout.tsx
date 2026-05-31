import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "jobnow",
  description: "Your daily AI-ranked job pipeline",
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
