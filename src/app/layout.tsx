import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ROMI | Hospital Access",
  description: "ROMI appointment check-in and door activity dashboard.",
  icons: {
    icon: { url: "/favicon.ico?v=2", type: "image/x-icon" },
    shortcut: "/favicon.ico?v=2",
    apple: "/logo.png",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ar" dir="rtl">
      <body>{children}</body>
    </html>
  );
}
