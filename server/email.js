// Sends the verification code via Resend. Without RESEND_API_KEY (dev), it just
// logs the code so the flow is testable with no external service.

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || "SnapGut <onboarding@resend.dev>";

let resend = null;
async function getResend() {
  if (!resend) {
    const { Resend } = await import("resend");
    resend = new Resend(RESEND_API_KEY);
  }
  return resend;
}

/** Returns { dev: true, code } in dev so the client can auto-fill for testing. */
export async function sendCode(email, code) {
  if (!RESEND_API_KEY) {
    console.log(`[dev] verification code for ${email}: ${code}`);
    return { dev: true, code };
  }
  const client = await getResend();
  // The Resend SDK resolves with { data, error } instead of rejecting, so an
  // unchecked call reports success for a rejected send (bad sender domain, revoked
  // key, suppressed recipient). Surface it so /api/auth/request answers with an
  // error rather than telling the user to check an inbox that will stay empty.
  const { data, error } = await client.emails.send({
    from: EMAIL_FROM,
    to: email,
    subject: `Your SnapGut code: ${code}`,
    text: `Your SnapGut verification code is ${code}. It expires in 10 minutes.`,
    html: `<div style="font-family:system-ui,sans-serif;max-width:420px;margin:auto">
      <h2 style="margin:0 0 8px">Your SnapGut code</h2>
      <p style="color:#555;margin:0 0 16px">Enter this code to sign in. It expires in 10 minutes.</p>
      <div style="font-size:32px;font-weight:800;letter-spacing:6px;background:#faf7ef;border-radius:12px;padding:16px;text-align:center">${code}</div>
    </div>`,
  });

  if (error) {
    // Log the provider's reason (no address, no code, no key) and let the caller 500.
    console.error(`email send failed: ${error.name ?? "error"}: ${error.message ?? ""}`);
    throw new Error("email_send_failed");
  }
  return { dev: false, id: data?.id };
}
