import { env } from "@/lib/env";
import { issueLoginToken } from "@/services/auth";

/*
  Prints a working sign-in link for a partner, without going near the dashboard.

  ⚠️ DEVELOPMENT CONVENIENCE, and it exists because the honest flow is genuinely awkward right now:
  there is no mailer, so the app tells you to check an email that will never arrive and the actual
  link comes out in the API's stdout. Finding it means having the right terminal open, scrolled to
  the right place, at the right moment. This just hands it to you.

  Usage:
    npm run partner:link -- sorinn.dumitrascu+partener@gmail.com

  Delete this the day Resend is wired — at that point the link goes where it's supposed to, and a
  CLI that mints credentials on demand is a liability rather than a convenience.

  ⚠️ Unlike the HTTP endpoint, this DOES tell you when an address has no account. That's fine here
  and wrong there: the endpoint is reachable by anyone and would be enumerating our partners'
  emails, whereas this needs a shell on the machine holding DATABASE_URL. Someone with that has far
  better options than guessing addresses.
*/

const [emailArg] = process.argv.slice(2);

if (!emailArg || !emailArg.includes("@")) {
  console.error("Usage: npm run partner:link -- <email>");
  console.error("\nThe email must belong to an active venue_owner. Create one with:");
  console.error('  npm run partner:grant -- <email> "Full Name" <partner-cui>');
  process.exit(1);
}

const email = emailArg.trim();
const issued = await issueLoginToken(email);

if (!issued) {
  console.error(`✗ No active venue_owner with the address ${email}.`);
  console.error("\nMost likely one of:");
  console.error("  · the account doesn't exist yet — run partner:grant");
  console.error("  · it exists as a platform_owner instead (an email can only be one)");
  console.error("  · it was suspended");
  process.exit(1);
}

if (!env.PARTNER_BASE_URL) {
  console.error("✗ PARTNER_BASE_URL is not set, so there's no origin to build a link against.");
  console.error("  Add it to .env — http://localhost:3003 in dev.");
  process.exit(1);
}

const link = `${env.PARTNER_BASE_URL.replace(/\/+$/, "")}/acces/${issued.token}`;

console.log(`\nSign-in link for ${email}:\n`);
console.log(`  ${link}\n`);
console.log(
  `Valid until ${issued.expiresAt.toLocaleString("ro-RO", { timeZone: "Europe/Bucharest" })}, single use.`,
);
/* Worth saying out loud, because it's the confusing part: asking for another link — here or
   through the form — kills this one immediately. */
console.log("Requesting another link, by any route, invalidates this one.");

process.exit(0);
