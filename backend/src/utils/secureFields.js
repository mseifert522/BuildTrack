const crypto = require('crypto');

function getEncryptionKey() {
  const keySource = process.env.CONTRACTOR_ONBOARDING_ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!keySource) {
    throw new Error('Contractor onboarding encryption key is not configured');
  }
  return crypto.createHash('sha256').update(keySource).digest();
}

function encryptJson(payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    'v1',
    iv.toString('base64'),
    authTag.toString('base64'),
    encrypted.toString('base64'),
  ].join(':');
}

function decryptJson(value) {
  const [version, ivB64, tagB64, encryptedB64] = String(value || '').split(':');
  if (version !== 'v1' || !ivB64 || !tagB64 || !encryptedB64) {
    throw new Error('Invalid encrypted payload');
  }

  const decipher = crypto.createDecipheriv('aes-256-gcm', getEncryptionKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedB64, 'base64')),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString('utf8'));
}

// Whole files (W-9s, voided checks) are sealed with their own key derived from the
// same secret, so a copied uploads volume or backup holds only ciphertext.
// Layout: 'BTF1' | 12-byte IV | 16-byte GCM tag | ciphertext.
const FILE_MAGIC = Buffer.from('BTF1', 'ascii');

function getFileKey() {
  return crypto.createHmac('sha256', getEncryptionKey()).update('buildtrack:encrypted-files:v1').digest();
}

function encryptBuffer(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getFileKey(), iv);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([FILE_MAGIC, iv, cipher.getAuthTag(), body]);
}

function decryptBuffer(sealed) {
  if (!Buffer.isBuffer(sealed) || sealed.length < 32 || !sealed.subarray(0, 4).equals(FILE_MAGIC)) {
    throw new Error('Invalid encrypted file');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', getFileKey(), sealed.subarray(4, 16));
  decipher.setAuthTag(sealed.subarray(16, 32));
  return Buffer.concat([decipher.update(sealed.subarray(32)), decipher.final()]);
}

module.exports = { encryptJson, decryptJson, encryptBuffer, decryptBuffer };
