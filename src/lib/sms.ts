import { env } from "@/lib/env";

/*
  Sending an SMS. There is no provider wired yet, and this file is the whole seam where one goes.

  ⚠️ Deliberately one function with a boring signature, for the same reason lib/email.ts is: when
  Twilio or a Romanian aggregator is chosen, the change is the body of `deliverPhoneCode` and
  nothing else. Anything that leaks a provider's shape into the service layer — a client object
  passed around, a provider-specific error type — makes the swap a refactor instead of an edit.

  What the provider choice still has to answer, none of which is decided:
    · sender ID registration (Romania requires it for alphanumeric senders)
    · per-message cost, which is what makes the resend cooldown a money decision and not a UX one
    · line-type lookup, so VOIP numbers can be rejected — see normalisePhone in
      services/member-auth.ts, which cannot do it from the digits alone
*/

/*
  Hands a verification code to a member.

  Returns whether it actually went out. ⚠️ Never throws: the caller answers 204 either way, because
  an endpoint that behaves differently when delivery fails is one that tells an attacker which
  numbers are real.

  With ALLOW_INSECURE_OTP the code goes to stdout and the route echoes it in the response, which is
  the only way to sign in on a laptop today. Without it this logs an error and nobody gets in —
  loudly, because the alternative is a member staring at a screen waiting for an SMS that was never
  going to arrive.
*/
export async function deliverPhoneCode(phone: string, code: string): Promise<boolean> {
  if (env.ALLOW_INSECURE_OTP === "yes") {
    console.log(`[otp] ${phone} → ${code}  (ALLOW_INSECURE_OTP is on — local development only)`);
    return true;
  }

  console.error(
    `no SMS provider configured: verification code for ${phone} was minted and cannot be delivered`,
  );
  return false;
}
