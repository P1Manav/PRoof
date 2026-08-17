import "./globals.css";

export const metadata = {
  title: "PRoof",
  description: "A GitHub App that logs developer confidence on PRs and follows up on the outcome.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
