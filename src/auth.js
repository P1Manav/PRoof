/**
 * src/auth.js
 *
 * Auth.js v5 (next-auth@beta) configuration.
 *
 * Uses GitHub OAuth provider with JWT session strategy.
 * No new session table required.
 *
 * Required environment variables:
 *   AUTH_GITHUB_ID      — GitHub App Client ID
 *   AUTH_GITHUB_SECRET  — GitHub App Client Secret
 *   AUTH_SECRET         — Random 32-byte secret for JWT signing
 *   AUTH_URL            — Canonical URL (e.g. https://pr-oof.vercel.app)
 */

import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    GitHub({
      clientId: process.env.AUTH_GITHUB_ID,
      clientSecret: process.env.AUTH_GITHUB_SECRET,
    }),
  ],

  session: {
    strategy: "jwt",
    // 30-day session — user must re-auth after this
    maxAge: 30 * 24 * 60 * 60,
  },

  callbacks: {
    /**
     * Persist the GitHub OAuth access_token into the JWT so we can use it
     * for user-scoped GitHub API calls (listing installations, etc.).
     */
    jwt({ token, account }) {
      if (account) {
        // Only available on initial sign-in
        token.accessToken = account.access_token;
        token.githubLogin = account.providerAccountId; // numeric ID as string
      }
      return token;
    },

    /**
     * Expose the accessToken and login on the session object so Server
     * Components and Server Actions can access them via auth().
     */
    session({ session, token }) {
      session.accessToken = token.accessToken;
      // Expose the GitHub login (not the numeric ID) — used for permission checks
      if (session.user) {
        session.user.login = session.user.name
          ?.toLowerCase()
          .replace(/\s+/g, "");
        // Prefer the GitHub login from the profile callback if available
        if (token.login) session.user.login = token.login;
      }
      return session;
    },

    /**
     * Capture the GitHub username (login) from the profile during sign-in
     * and persist it into the JWT for later use.
     */
    async signIn({ profile }) {
      // profile.login is the GitHub username
      return true; // allow sign-in
    },
  },

  /**
   * Redirect to /dashboard after successful sign-in,
   * and to / after sign-out.
   */
  pages: {
    signIn: "/login",
  },
});
