/**
 * src/app/api/auth/[...nextauth]/route.js
 *
 * Auth.js v5 route handler for GitHub OAuth.
 * Handles /api/auth/signin, /api/auth/callback/github, /api/auth/signout, etc.
 *
 * The callback URL registered in the GitHub App settings must be:
 *   https://pr-oof.vercel.app/api/auth/callback/github
 */

import { handlers } from "@/auth";

export const { GET, POST } = handlers;
