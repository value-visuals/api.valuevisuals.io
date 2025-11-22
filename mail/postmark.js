import { ServerClient } from "postmark";

let _client = null;
function getClient() {
  const token = process.env.POSTMARK_TOKEN;
  if (!token) {
    throw new Error(
      "Missing POSTMARK_TOKEN. Set it in your environment or .env before calling sendWelcomeEmail()."
    );
  }
  if (!_client) _client = new ServerClient(token);
  return _client;
}

export async function sendWelcomeEmail(to = {}) {
  const client = getClient(); 
  return client.sendEmail({
    From: process.env.FROM_EMAIL,
    To: to,
    Subject: "Welcome to Value Visuals!",
    HtmlBody: `
      <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.5;">
        <h1 style="color:#2c3e50;">Welcome to Value Visuals</h1>
        <p>We’re excited to have you onboard.</p>
        <p>
          Value Visuals is your intelligent asset tracking application — built to give you clear, actionable 
          investment insights. Track portfolio performance, monitor asset movements, and uncover trends 
          that help you make smarter financial decisions.
        </p>
        <p>
          Our mission is simple: to empower investors and teams with transparent, data-driven analytics 
          that help you move faster, think smarter, and invest better.
        </p>
        <p>
          Thanks for joining us — your smarter investment journey starts now.
        </p>
        <p style="margin-top: 2em;">Best regards,<br/>The Value Visuals Team</p>
      </div>
    `,
    TextBody: `
Welcome to Value Visuals!

We’re excited to have you onboard.

Value Visuals is your intelligent asset tracking application — built to give you clear, actionable investment insights.
Track portfolio performance, monitor asset movements, and uncover trends that help you make smarter financial decisions.

Our mission is simple: to empower investors and teams with transparent, data-driven analytics that help you move faster, think smarter, and invest better.

Thanks for joining us — your smarter investment journey starts now.

Best regards,
The Value Visuals Team
    `,
    MessageStream: process.env.POSTMARK_MESSAGE_STREAM || "outbound",
  });
}


export async function sendVolunteerApplicationReceipt({ to, firstName, jobTitle, jobId }) {
  const client = getClient();
  const safeTitle = jobTitle || "the position";
  const safeId = jobId ? ` (${jobId})` : "";

  return client.sendEmail({
    From: process.env.FROM_EMAIL,
    To: to,
    Subject: `We received your application for ${safeTitle}${safeId}`,
    HtmlBody: `
      <div style="font-family: Arial, sans-serif; color:#333; line-height:1.5;">
        <h2 style="margin:0 0 12px;">Thank you ${firstName || ""}!</h2>
        <p>We appreciate your interest in <strong>${safeTitle}${safeId}</strong> at Value Visuals.</p>
        <p>
          Our team will carefully review your application and reach out if there’s a fit. 
          In the meantime, stay connected and learn more about what we’re building:
        </p>
        <ul>
          <li>🌐 Visit our website: <a href="https://valuevisuals.io" style="color:#007bff; text-decoration:none;">ValueVisuals.io</a></li>
          <li>💡 Read insights on our blog and stay updated with the latest in investment analytics</li>
        </ul>
        <p>If you have any questions, just reply to this email — we’re here to help!</p>
        <p style="margin-top:18px;">Best,<br>— The Value Visuals Team</p>
      </div>
    `,
    TextBody: `
Thank you ${firstName || ""}!
We appreciate your interest in ${safeTitle}${safeId} at Value Visuals.

Our team will carefully review your application and reach out if there’s a fit. 
In the meantime, stay connected and learn more about what we’re building:

🌐 Visit our website: ValueVisuals.io
💡 Read insights on our blog and stay updated with the latest in investment analytics.

If you have any questions, just reply to this email — we’re here to help!

— The Value Visuals Team
    `,
    MessageStream: process.env.POSTMARK_MESSAGE_STREAM || "outbound",
  });
}


export async function notifyAdminOfVolunteer({ applicant, jobTitle, jobId }) {
  const client = getClient();
  const safeTitle = jobTitle || "Open Position";
  const safeId = jobId || "N/A";
  const {
    id,
    firstName, middleName, lastName,
    phone, email, socials, resumeUrl,
    createdAt
  } = applicant;

  const socialLines = Object.entries(socials || {})
    .map(([k, v]) => `<li><strong>${k}</strong>: ${v}</li>`)
    .join("") || "<li><em>None provided</em></li>";

  return client.sendEmail({
    From: process.env.FROM_EMAIL,
    To: "info@valuevisuals.io",
    Subject: `New Application: ${safeTitle} (${safeId})`,
    HtmlBody: `
      <div style="font-family: Arial, sans-serif; color:#333; line-height:1.5;">
        <h2 style="margin:0 0 12px;">New Application Received</h2>
        <p><strong>Position:</strong> ${safeTitle} (${safeId})</p>
        <p><strong>Applicant ID:</strong> ${id}</p>
        <h3 style="margin:16px 0 8px;">Applicant Details</h3>
        <ul>
          <li><strong>Name:</strong> ${[firstName, middleName, lastName].filter(Boolean).join(" ")}</li>
          <li><strong>Email:</strong> ${email}</li>
          <li><strong>Phone:</strong> ${phone}</li>
          <li><strong>Resume:</strong> ${resumeUrl ? `<a href="${resumeUrl}">View resume</a>` : "Not uploaded"}</li>
          <li><strong>Submitted At:</strong> ${createdAt || "Server Timestamp"}</li>
        </ul>
        <h3 style="margin:16px 0 8px;">Social Profiles</h3>
        <ul>${socialLines}</ul>
      </div>
    `,
    TextBody: `
New Application

Position: ${safeTitle} (${safeId})
Applicant ID: ${id}

Applicant Details:
- Name: ${[firstName, middleName, lastName].filter(Boolean).join(" ")}
- Email: ${email}
- Phone: ${phone}
- Resume: ${resumeUrl ? resumeUrl : "Not uploaded"}
- Submitted At: ${createdAt || "Server Timestamp"}

Social Profiles:
${Object.entries(socials || {}).map(([k,v]) => `- ${k}: ${v}`).join("\n") || "- None provided"}
    `,
    MessageStream: process.env.POSTMARK_MESSAGE_STREAM || "outbound",
  });
}
