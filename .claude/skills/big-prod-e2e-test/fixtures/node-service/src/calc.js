export function add(a, b) {
  return a + b;
}

export function subtract(a, b) {
  return a - b;
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}
