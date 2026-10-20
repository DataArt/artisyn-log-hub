import * as argon2 from 'argon2';

/**
 * Hash a password using Argon2id.
 *
 * Argon2 is a memory-hard key derivation function that provides:
 * - Memory-hard algorithm: Resistant to GPU/ASIC attacks
 * - Configurable cost parameters: Balance between security and performance
 * - Type variants: Argon2id combines benefits of Argon2i and Argon2d
 *
 * Parameters tuned for telemetry use case (not banking/critical applications):
 * - type: argon2id (balanced security against GPU and side-channel attacks)
 * - timeCost: 2 (number of iterations)
 * - memoryCost: 19 (2^19 KiB = 512 MiB per hash operation)
 * - parallelism: 1 (single thread)
 *
 * Expected performance: ~15-25ms per hash operation on standard hardware.
 *
 * @param plaintext The plaintext password or API key
 * @returns Promise resolving to the Argon2 hash
 */
export async function hashPassword(plaintext: string): Promise<string> {
  return argon2.hash(plaintext, {
    type: argon2.argon2id,
    timeCost: 2,
    memoryCost: 19,
    parallelism: 1,
  });
}

/**
 * Compare a plaintext password/key against a stored Argon2 hash.
 *
 * Uses constant-time comparison to prevent timing attacks.
 *
 * @param plaintext The plaintext password or API key to verify
 * @param stored The stored Argon2 hash
 * @returns Promise resolving to true if password matches, false otherwise
 */
export async function comparePassword(
  plaintext: string,
  stored: string,
): Promise<boolean> {
  try {
    return await argon2.verify(stored, plaintext);
  } catch {
    // Invalid hash format or verification error
    return false;
  }
}
