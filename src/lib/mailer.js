'use strict';

/**
 * Email channel — Nodemailer over Hostinger SMTP.
 *
 * The transport is created lazily and reused. When SMTP is not configured the
 * module reports itself as unavailable rather than throwing, so the app runs
 * (and logs sends as `skipped`) on a box with no mail credentials.
 */

const nodemailer = require('nodemailer');
const config = require('../config');

let transport = null;

function available() {
  return Boolean(config.smtp.configured);
}

function getTransport() {
  if (transport) return transport;
  if (!available()) throw new Error('SMTP is not configured.');

  transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,          // true for 465, false for 587 (STARTTLS)
    auth: { user: config.smtp.user, pass: config.smtp.pass },
    pool: true,
    maxConnections: 3,
    maxMessages: 50,
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });

  return transport;
}

/** Verify credentials — used by the admin diagnostics screen. */
async function verify() {
  if (!available()) return { ok: false, error: 'SMTP is not configured.' };
  try {
    await getTransport().verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Send one message.
 * @returns {{ok:boolean, messageId?:string, error?:string}}
 */
async function send({ to, subject, html, text, cc, bcc, replyTo }) {
  if (!available()) {
    return { ok: false, error: 'SMTP is not configured.' };
  }
  try {
    const info = await getTransport().sendMail({
      from: { name: config.smtp.fromName, address: config.smtp.fromEmail },
      to,
      cc: cc || undefined,
      bcc: bcc || undefined,
      replyTo: replyTo || undefined,
      subject,
      html,
      text,
    });
    return { ok: true, messageId: info.messageId };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function close() {
  if (transport) {
    transport.close();
    transport = null;
  }
}

module.exports = { send, verify, available, close };
