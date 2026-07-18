import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Product Studio",
  description: "A local-first control plane for durable product work.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
