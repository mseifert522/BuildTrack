function cleanPhone(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const digits = raw.replace(/[^\d+]/g, '');
  return digits.length >= 7 ? raw : '';
}

function providerConfig() {
  const provider = String(process.env.TEXT_MESSAGE_PROVIDER || '').trim().toLowerCase();
  const webhookUrl = String(process.env.TEXT_MESSAGE_WEBHOOK_URL || '').trim();
  return {
    provider: provider || 'tbd',
    webhookUrl,
    webhookToken: String(process.env.TEXT_MESSAGE_WEBHOOK_TOKEN || '').trim(),
  };
}

async function parseProviderResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (_) {
    return { raw: text.slice(0, 500) };
  }
}

async function sendContractorText({ to, body, metadata = {} }) {
  const phone = cleanPhone(to);
  if (!phone) {
    return {
      status: 'missing_phone',
      provider: 'none',
      providerMessageId: null,
      errorMessage: 'Contractor does not have a usable phone number on file.',
    };
  }

  const config = providerConfig();
  if (config.provider === 'webhook' && config.webhookUrl) {
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (config.webhookToken) headers.Authorization = `Bearer ${config.webhookToken}`;

      const response = await fetch(config.webhookUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ to: phone, body, metadata }),
      });
      const payload = await parseProviderResponse(response);
      if (!response.ok) {
        return {
          status: 'failed',
          provider: 'webhook',
          providerMessageId: payload.message_id || payload.id || null,
          errorMessage: payload.error || payload.message || `Provider returned HTTP ${response.status}`,
        };
      }
      return {
        status: payload.status || 'sent',
        provider: 'webhook',
        providerMessageId: payload.message_id || payload.id || null,
        errorMessage: null,
      };
    } catch (err) {
      return {
        status: 'failed',
        provider: 'webhook',
        providerMessageId: null,
        errorMessage: err?.message || 'Unable to reach text-message provider.',
      };
    }
  }

  return {
    status: 'provider_not_configured',
    provider: config.provider,
    providerMessageId: null,
    errorMessage: 'Text message provider is not configured. Message was saved as an office record.',
  };
}

module.exports = {
  cleanPhone,
  sendContractorText,
};
