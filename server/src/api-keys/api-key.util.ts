import { randomBytes } from 'crypto';

const CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

function randomString(length: number): string {
  const bytes = randomBytes(length * 2);
  let result = '';
  for (let i = 0; i < bytes.length && result.length < length; i++) {
    const idx = bytes[i] % CHARS.length;
    result += CHARS[idx];
  }
  return result;
}

export function generateApiKey(): { key: string; slug: string } {
  const slug = randomString(6);
  const suffix = randomString(7);
  const key = `${slug}-${suffix}`;
  return { key, slug };
}
