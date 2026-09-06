import { BadRequestException, Injectable } from '@nestjs/common';
import { randomBytes, randomUUID } from 'crypto';

type CaptchaEntry = { code: string; exp: number };

/**
 * 管理端图形验证码（内存存储，单实例够用）。
 * 验证码一次性使用，默认 5 分钟过期。
 */
@Injectable()
export class AdminCaptchaService {
  private readonly store = new Map<string, CaptchaEntry>();
  private readonly ttlMs = Number(process.env.ADMIN_CAPTCHA_TTL_MS || 5 * 60 * 1000);
  private readonly alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  create(): { id: string; image: string; expiresInSec: number } {
    this.gc();
    const code = this.randomCode(4);
    const id = randomUUID();
    this.store.set(id, { code: code.toLowerCase(), exp: Date.now() + this.ttlMs });
    const svg = this.renderSvg(code);
    const image = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
    return { id, image, expiresInSec: Math.floor(this.ttlMs / 1000) };
  }

  /** 校验并消费；失败抛 BadRequestException */
  consume(id: string | undefined, code: string | undefined) {
    if (!id?.trim() || !code?.trim()) {
      throw new BadRequestException('请填写图形验证码');
    }
    const entry = this.store.get(id.trim());
    this.store.delete(id.trim());
    if (!entry || entry.exp < Date.now()) {
      throw new BadRequestException('验证码已过期，请刷新后重试');
    }
    if (entry.code !== code.trim().toLowerCase()) {
      throw new BadRequestException('验证码错误');
    }
  }

  private randomCode(len: number) {
    let out = '';
    const bytes = randomBytes(len);
    for (let i = 0; i < len; i++) {
      out += this.alphabet[bytes[i] % this.alphabet.length];
    }
    return out;
  }

  private renderSvg(code: string) {
    const w = 132;
    const h = 44;
    const chars = code.split('');
    const noise: string[] = [];
    for (let i = 0; i < 5; i++) {
      const x1 = Math.floor(Math.random() * w);
      const y1 = Math.floor(Math.random() * h);
      const x2 = Math.floor(Math.random() * w);
      const y2 = Math.floor(Math.random() * h);
      const c = `rgb(${80 + Math.floor(Math.random() * 120)},${90 + Math.floor(Math.random() * 100)},${110 + Math.floor(Math.random() * 100)})`;
      noise.push(
        `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${c}" stroke-width="1" opacity="0.55"/>`,
      );
    }
    for (let i = 0; i < 18; i++) {
      const cx = Math.floor(Math.random() * w);
      const cy = Math.floor(Math.random() * h);
      noise.push(
        `<circle cx="${cx}" cy="${cy}" r="1" fill="rgba(200,210,230,0.45)"/>`,
      );
    }
    const letters = chars
      .map((ch, i) => {
        const x = 18 + i * 28;
        const y = 28 + (Math.random() > 0.5 ? 2 : -2);
        const rot = Math.floor(Math.random() * 28) - 14;
        const fill = `rgb(${160 + Math.floor(Math.random() * 80)},${170 + Math.floor(Math.random() * 70)},${200 + Math.floor(Math.random() * 40)})`;
        return `<text x="${x}" y="${y}" fill="${fill}" font-size="24" font-family="Verdana,Arial,sans-serif" font-weight="700" transform="rotate(${rot} ${x} ${y})">${ch}</text>`;
      })
      .join('');
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect width="100%" height="100%" rx="6" fill="#1a2332"/>
  ${noise.join('')}
  ${letters}
</svg>`;
  }

  private gc() {
    const now = Date.now();
    if (this.store.size < 200) {
      for (const [k, v] of this.store) {
        if (v.exp < now) this.store.delete(k);
      }
      return;
    }
    for (const [k, v] of this.store) {
      if (v.exp < now) this.store.delete(k);
    }
  }
}
