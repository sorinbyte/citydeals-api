import { env, smsEnabled } from "@/lib/env";

/*
  Sending an SMS, via SMSO (smso.ro).

  A Romanian gateway rather than Twilio — roughly half the price per message for +40 traffic, which
  is the only traffic this product has. Plain REST over `fetch`, no SDK, which keeps the dependency
  list where AGENTS.md wants it.

  ⚠️ We use the SENDING half only. The code is minted, hashed and verified in
  services/member-auth.ts, so no provider ever holds the secret that decides whether someone gets an
  account. SMSO offers an OTP product; we deliberately don't use it. Our table is the source of
  truth for attempts, expiry and single-use, and handing that to a third party would mean trusting
  their answer about whether a verification succeeded.

  API: POST https://app.smso.ro/api/v1/send, form-encoded, X-Authorization header.
  Docs: https://api-docs.smso.ro/
*/

const SEND_URL = "https://app.smso.ro/api/v1/send";

/*
  ⚠️ MUST STAY UNDER 70 CHARACTERS, and that is not a style rule.

  ă î â ș ț are outside the GSM-7 alphabet, so any Romanian text forces the message into UCS-2 —
  where one segment is 70 characters, not 160. At 49 characters this is comfortably one segment;
  cross 70 and every single sign-up silently costs two, forever, with nothing to notice it by.

  Keeping the diacritics rather than stripping them is deliberate (AGENTS.md: natives notice), and
  it's free as long as the sentence stays short. The provider's `remove_special_chars` flag would
  buy headroom by making the copy wrong, which is the wrong trade for the one message every member
  receives before they've decided what they think of us.

  "Crunch" is in it for the OS autofill heuristics as much as for the member.
*/
function codeMessage(code: string): string {
  return `Codul tău Crunch este ${code}. Expiră în 5 minute.`;
}

/*
  Hands a verification code to a member.

  Returns whether it actually went out. ⚠️ NEVER throws: the caller answers 204 either way, because
  an endpoint that behaves differently when delivery fails is one that tells an attacker which
  numbers are real.

  With ALLOW_INSECURE_OTP the code goes to stdout and the route echoes it in the response, which is
  how anyone signs in locally without spending money on an SMS.
*/
export async function deliverPhoneCode(phone: string, code: string): Promise<boolean> {
  if (!smsEnabled) {
    /* The boot check guarantees this only happens with ALLOW_INSECURE_OTP set, so it's a local run. */
    console.log(`[otp] ${phone} → ${code}  (ALLOW_INSECURE_OTP is on — local development only)`);
    return true;
  }

  let response: Response;
  try {
    response = await fetch(SEND_URL, {
      method: "POST",
      headers: {
        "X-Authorization": env.SMSO_API_KEY as string,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      /* Form-encoded, not JSON — their endpoint takes application/x-www-form-urlencoded. */
      body: new URLSearchParams({
        to: phone,
        sender: String(env.SMSO_SENDER_ID),
        body: codeMessage(code),
        /* Marks it transactional so it is never filtered against marketing unsubscribes — a member
           who once opted out of promotions must still be able to sign in. */
        type: "otp",
      }),
      /* A verification code is worthless by the time a slow gateway finishes thinking about it, and
         the member is staring at a screen waiting. Fail fast and let them tap resend. */
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    console.error(`SMSO request failed for ${phone}:`, error);
    return false;
  }

  if (response.ok) return true;

  /*
    ⚠️ 402 is the one to actually watch for. Out of credit means every sign-up in the product stops
    working, and the only outward sign is members saying the SMS never arrived — which looks exactly
    like a carrier problem. It gets its own line so it's greppable in the logs and alertable later.

    409 is their per-minute rate limit. Our own limiter (3 per phone / 10 per IP per 15 min) should
    keep us well clear of it, so seeing this means either a spike or their ceiling is lower than we
    assumed — worth knowing which.
  */
  const detail = await response.text().catch(() => "");
  if (response.status === 402) {
    console.error(
      `⚠️ SMSO CREDIT EXHAUSTED — no member can sign in until it is topped up. ${detail}`,
    );
  } else if (response.status === 409) {
    console.error(`SMSO rate limit hit (per-minute ceiling) for ${phone}. ${detail}`);
  } else {
    console.error(`SMSO refused the send for ${phone}: HTTP ${response.status}. ${detail}`);
  }

  return false;
}
