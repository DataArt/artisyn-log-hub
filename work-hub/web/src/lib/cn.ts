/** A class-name value: a string, a falsy skip, or a nested list of those. */
export type ClassValue = string | false | null | undefined | ClassValue[];

/**
 * Joins class names, skipping falsy values. Work Hub keeps no `clsx`
 * dependency: the primitives here are small, so a caller that overrides a utility passes a class
 * the primitive does not set instead of relying on conflict resolution.
 */
export function cn(...inputs: ClassValue[]): string {
  const out: string[] = [];
  const walk = (v: ClassValue) => {
    if (!v) return;
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    out.push(v);
  };
  inputs.forEach(walk);
  return out.join(" ");
}
