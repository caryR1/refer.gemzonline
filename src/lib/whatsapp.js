'use strict';

/**
 * WhatsApp channel — provider-agnostic.
 *
 * WhatsApp does not allow free-form business-initiated messages. Anything sent
 * outside a 24-hour window opened by the customer must use a template that Meta
 * has pre-approved. So a "template" here is a reference to an approved template
 * name plus an ordered list of variable values — the wording lives in Meta's
 * console, not in this app.
 *
 * Swapping provider means writing one more `send*` function and a case in
 * `send()`. Nothing else in the codebase knows which provider is in use.
 */

const config = require('../config');

function available() {
  return Boolean(config.whatsapp.configured);
}

/**
 * WhatsApp wants E.164 without the leading '+' for the Cloud API.
 * Returns null when the number is obviously unusable.
 */
function normalise(number) {
  if (!number) return null;
  const digits = String(number).replace(/[^\d]/g, '');
  if (digits.length < 8 || digits.length > 15) return null;
  return digits;
}

/** Meta WhatsApp Cloud API. */
async function sendViaMeta({ to, templateName, language, variables, bodyText }) {
  const url = `https://graph.facebook.com/${config.whatsapp.apiVersion}/${config.whatsapp.phoneNumberId}/messages`;

  const payload = templateName
    ? {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: language || config.whatsapp.defaultLanguage },
        components: (variables && variables.length)
          ? [{
            type: 'body',
            parameters: variables.map((v) => ({ type: 'text', text: String(v ?? '') })),
          }]
          : undefined,
      },
    }
    : {
      // Only valid inside an open 24-hour customer service window.
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: bodyText || '' },
    };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.whatsapp.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const detail = (data && data.error && data.error.message) || `HTTP ${res.status}`;
    return { ok: false, error: detail };
  }

  return {
    ok: true,
    messageId: data.messages && data.messages[0] ? data.messages[0].id : null,
  };
}

/** Twilio — kept so switching provider is a config change, not a rewrite. */
async function sendViaTwilio({ to, templateName, variables, bodyText }) {
  const sid = config.whatsapp.twilioAccountSid;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;

  const form = new URLSearchParams();
  form.set('From', `whatsapp:${config.whatsapp.twilioFrom.replace(/^whatsapp:/, '')}`);
  form.set('To', `whatsapp:+${to}`);

  if (templateName) {
    form.set('ContentSid', templateName);
    if (variables && variables.length) {
      const vars = {};
      variables.forEach((v, i) => { vars[String(i + 1)] = String(v ?? ''); });
      form.set('ContentVariables', JSON.stringify(vars));
    }
  } else {
    form.set('Body', bodyText || '');
  }

  const auth = Buffer.from(`${sid}:${config.whatsapp.twilioAuthToken}`).toString('base64');
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: data.message || `HTTP ${res.status}` };
  return { ok: true, messageId: data.sid || null };
}

/**
 * Send a WhatsApp message.
 *
 * @param {object} opts
 * @param {string} opts.to            recipient number, any format
 * @param {string} [opts.templateName] Meta-approved template name
 * @param {string} [opts.language]
 * @param {string[]} [opts.variables] ordered values for the template's slots
 * @param {string} [opts.bodyText]    free-form; only valid in an open window
 * @returns {{ok:boolean, messageId?:string, error?:string, skipped?:boolean}}
 */
async function send(opts) {
  if (!available()) {
    return { ok: false, skipped: true, error: 'WhatsApp is not configured.' };
  }

  const to = normalise(opts.to);
  if (!to) {
    return { ok: false, skipped: true, error: 'No usable WhatsApp number.' };
  }

  try {
    if (config.whatsapp.provider === 'twilio') {
      return await sendViaTwilio({ ...opts, to });
    }
    return await sendViaMeta({ ...opts, to });
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Check credentials without sending — used by admin diagnostics. */
async function verify() {
  if (!available()) return { ok: false, error: 'WhatsApp is not configured.' };
  if (config.whatsapp.provider !== 'meta') {
    return { ok: true, note: 'Twilio credentials present; not verified without a send.' };
  }
  try {
    const url = `https://graph.facebook.com/${config.whatsapp.apiVersion}/${config.whatsapp.phoneNumberId}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${config.whatsapp.accessToken}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: (data.error && data.error.message) || `HTTP ${res.status}` };
    }
    return { ok: true, note: `Connected to ${data.display_phone_number || data.id || 'number'}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { send, verify, available, normalise };
