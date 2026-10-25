import { Resend } from "resend";
import { env } from "./env";

/*
  The only place in this codebase that talks to Resend, and the only place that owns user-facing
  copy.

  ⚠️ That second part is a deliberate exception to the rule, so nobody "fixes" it later: everywhere
  else the API returns an error CODE and the web repos own the words, because the same code gets
  worded differently on the marketing site, in the dashboards and in the mobile app. An email has no
  client to render it — we are the client — so the copy has to live here.

  Note what the copy does NOT contain: the product name. The brand lives in EMAIL_FROM's display
  name, which is env, so a rename is a config change rather than a grep through Romanian prose.
*/

const resend = new Resend(env.RESEND_API_KEY);

type Message = { subject: string; html: string; text: string };

/*
  Anything interpolated into the HTML goes through this. Company names come from the database and a
  partner called "Bistro & Co" would otherwise produce broken markup — and an apostrophe in a name is
  a genuinely common Romanian case.
*/
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* Partner-facing dates are read in local time. UTC here would produce an expiry that reads an hour
   or three off and a support email we'd struggle to reproduce. */
function formatBucharest(at: Date): string {
  return new Intl.DateTimeFormat("ro-RO", {
    timeZone: "Europe/Bucharest",
    dateStyle: "long",
    timeStyle: "short",
  }).format(at);
}

/*
  One shell for both emails. Deliberately plain: a single column, system fonts, no images, no
  external stylesheet. Transactional mail renders in clients that predate flexbox, and the login
  link is the one message that must survive Outlook.
*/
function layout(heading: string, bodyHtml: string, link: string, cta: string): string {
  return `<!doctype html>
<html lang="ro">
<body style="margin:0;padding:24px;background:#f5f5f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1c1917;">
  <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;">
    <h1 style="margin:0 0 16px;font-size:20px;font-weight:600;">${escapeHtml(heading)}</h1>
    ${bodyHtml}
    <a href="${escapeHtml(link)}" style="display:inline-block;margin:24px 0;padding:12px 24px;background:#1c1917;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:500;">${escapeHtml(cta)}</a>
    <p style="margin:24px 0 0;font-size:13px;line-height:1.5;color:#78716c;">
      Dacă butonul nu funcționează, copiază adresa aceasta în browser:<br>
      <span style="word-break:break-all;">${escapeHtml(link)}</span>
    </p>
  </div>
</body>
</html>`;
}

export function loginLinkEmail(link: string): Message {
  return {
    subject: "Linkul tău de acces",
    html: layout(
      "Intră în contul de partener",
      `<p style="margin:0;font-size:15px;line-height:1.6;">Ai cerut un link de acces. Apasă butonul de mai jos ca să intri — nu ai nevoie de parolă.</p>
       <p style="margin:12px 0 0;font-size:15px;line-height:1.6;">Linkul e valabil <strong>15 minute</strong> și poate fi folosit o singură dată. Dacă nu l-ai cerut tu, ignoră mesajul: fără el nimeni nu poate intra în cont.</p>`,
      link,
      "Intră în cont",
    ),
    /* Plain-text part is not optional. HTML-only transactional mail scores badly with spam filters,
       and this is the message that absolutely must not land in Junk. */
    text: [
      "Intră în contul de partener",
      "",
      "Ai cerut un link de acces. Deschide adresa de mai jos ca să intri — nu ai nevoie de parolă.",
      "",
      link,
      "",
      "Linkul e valabil 15 minute și poate fi folosit o singură dată.",
      "Dacă nu l-ai cerut tu, ignoră mesajul: fără el nimeni nu poate intra în cont.",
    ].join("\n"),
  };
}

export function inviteEmail(link: string, companyName: string, expiresAt: Date): Message {
  const expiry = formatBucharest(expiresAt);

  return {
    subject: "Ți-am creat un cont de partener",
    html: layout(
      "Bun venit",
      `<p style="margin:0;font-size:15px;line-height:1.6;">Ți-am creat un cont de partener pentru <strong>${escapeHtml(companyName)}</strong>. De aici îți administrezi localurile: program, fotografii, date de contact și ofertele active.</p>
       <p style="margin:12px 0 0;font-size:15px;line-height:1.6;">Apasă butonul ca să activezi contul. Nu ai nevoie de parolă — de fiecare dată îți trimitem un link de acces pe email.</p>
       <p style="margin:12px 0 0;font-size:15px;line-height:1.6;">Invitația e valabilă până pe <strong>${escapeHtml(expiry)}</strong>.</p>`,
      link,
      "Activează contul",
    ),
    text: [
      "Bun venit",
      "",
      `Ți-am creat un cont de partener pentru ${companyName}. De aici îți administrezi localurile:`,
      "program, fotografii, date de contact și ofertele active.",
      "",
      "Deschide adresa de mai jos ca să activezi contul:",
      "",
      link,
      "",
      "Nu ai nevoie de parolă — de fiecare dată îți trimitem un link de acces pe email.",
      `Invitația e valabilă până pe ${expiry}.`,
    ].join("\n"),
  };
}

/*
  "Confirm you want to hear when we launch" — the double opt-in for the marketing site's waitlist.
  Only a click on this link makes the address a subscriber; ignoring it is a no.
*/
export function waitlistConfirmEmail(link: string): Message {
  return {
    subject: "Confirmă adresa ca să afli când lansăm",
    html: layout(
      "Mai e un pas",
      `<p style="margin:0;font-size:15px;line-height:1.6;">Ai cerut să afli când lansăm aplicația. Confirmă adresa și îți trimitem un email în ziua lansării.</p>
       <p style="margin:12px 0 0;font-size:15px;line-height:1.6;">Dacă nu ai cerut tu asta, ignoră mesajul — fără confirmare nu primești nimic de la noi.</p>`,
      link,
      "Confirmă adresa",
    ),
    text: [
      "Mai e un pas",
      "",
      "Ai cerut să afli când lansăm aplicația. Confirmă adresa deschizând linkul de mai jos și îți",
      "trimitem un email în ziua lansării.",
      "",
      link,
      "",
      "Dacă nu ai cerut tu asta, ignoră mesajul — fără confirmare nu primești nimic de la noi.",
    ].join("\n"),
  };
}

/*
  The internal "someone filled in /parteneri" note, to us — not to the lead. Reply-To is set to the
  lead's address at the call site, so hitting Reply writes straight to them.

  No button: there's nothing to click through to that admin doesn't already have, and layout()
  insists on a link. Everything in the table is what a stranger typed, so all of it is escaped.
*/
export function partnerLeadEmail(lead: {
  venueName: string;
  contactName: string;
  category: string;
  phone: string;
  email: string;
  message: string | null;
  createdAt: string;
}): Message {
  const rows: Array<[string, string]> = [
    ["Local", lead.venueName],
    ["Persoană de contact", lead.contactName],
    ["Categorie", lead.category],
    ["Telefon", lead.phone],
    ["Email", lead.email],
    ["Mesaj", lead.message ?? "—"],
    ["Trimis", formatBucharest(new Date(lead.createdAt))],
  ];

  const table = rows
    .map(
      ([label, value]) =>
        `<tr><td style="padding:6px 16px 6px 0;vertical-align:top;font-size:13px;color:#78716c;white-space:nowrap;">${escapeHtml(label)}</td><td style="padding:6px 0;font-size:15px;line-height:1.5;white-space:pre-wrap;">${escapeHtml(value)}</td></tr>`,
    )
    .join("");

  return {
    subject: `Lead nou: ${lead.venueName}`,
    html: `<!doctype html>
<html lang="ro">
<body style="margin:0;padding:24px;background:#f5f5f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1c1917;">
  <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;">
    <h1 style="margin:0 0 16px;font-size:20px;font-weight:600;">Un local vrea să devină partener</h1>
    <table style="border-collapse:collapse;">${table}</table>
    <p style="margin:24px 0 0;font-size:13px;line-height:1.5;color:#78716c;">Răspunsul la acest email ajunge direct la persoana de contact. Lead-ul e salvat și în admin.</p>
  </div>
</body>
</html>`,
    text: [
      "Un local vrea să devină partener",
      "",
      ...rows.map(([label, value]) => `${label}: ${value}`),
      "",
      "Răspunsul la acest email ajunge direct la persoana de contact. Lead-ul e salvat și în admin.",
    ].join("\n"),
  };
}

/*
  Sends, and reports whether it worked. Never throws.

  ⚠️ Callers in the auth flow MUST NOT turn a false into a different HTTP response. request-link
  answers 204 whether or not the address exists, and a 500 on a mail failure would hand an attacker
  the account-enumeration oracle that the 204 exists to prevent. Log it here, loudly, and let the
  route stay boring.
*/
export async function sendEmail(
  to: string | string[],
  message: Message,
  options: { replyTo?: string } = {},
): Promise<boolean> {
  const recipients = Array.isArray(to) ? to.join(", ") : to;
  try {
    const { data, error } = await resend.emails.send({
      from: env.EMAIL_FROM,
      to,
      replyTo: options.replyTo,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });

    if (error) {
      console.error(`email to ${recipients} rejected by Resend:`, error.name, error.message);
      return false;
    }

    console.log(`email sent to ${recipients} (${data?.id ?? "no id"})`);
    return true;
  } catch (cause) {
    /* Network blip, DNS, Resend down. Same handling — the caller can't do anything useful with it
       and must not fail the request over it. */
    console.error(`email to ${recipients} failed to send:`, cause);
    return false;
  }
}
