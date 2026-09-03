import * as crypto from 'crypto';

const ALGO = 'aes-256-gcm';

function getKey(): Buffer {
  const hex = process.env.ENC_KEY || '';
  if (hex.length !== 64) {
    throw new Error('ENC_KEY 必须是 64 位 hex (32 字节)');
  }
  return Buffer.from(hex, 'hex');
}

/**
 * 加密敏感字段, 返回 iv:tag:cipher 的 base64 组合
 */
export function encrypt(plain: string): string {
  if (plain == null || plain === '') return '';
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
}

export function decrypt(payload: string): string {
  if (!payload) return '';
  const [ivB64, tagB64, dataB64] = payload.split(':');
  const key = getKey();
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]);
  return dec.toString('utf8');
}

/**
 * 脱敏展示: 只保留前4后4
 */
export function mask(value: string): string {
  if (!value) return '';
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}
