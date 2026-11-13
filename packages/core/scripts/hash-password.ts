/**
 * Prints an OWNER_PASSWORD_HASH for .env.
 *   pnpm hash-password 'your password'
 */
import { hashPassword } from '../src/crypto';

const password = process.argv[2];
if (!password || password.length < 10) {
  console.error('Usage: pnpm hash-password "a password of at least 10 characters"');
  process.exit(1);
}
const hash = await hashPassword(password);
console.log(`OWNER_PASSWORD_HASH='${hash}'`);
