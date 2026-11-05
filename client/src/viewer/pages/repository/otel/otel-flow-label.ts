/**
 * Node labels of the flow sankey (`OtelFlowSankey`, 2026-11-05): a label in the last column is
 * cut to the width actually free to its right — not to a fixed character count — so a long
 * session prompt uses the room the card has. Text is measured on a canvas in the label's own
 * font, which holds for any script (Cyrillic, CJK) where a per-character estimate does not.
 */

/** Labels of the inner columns sit over the bands, so they keep a short fixed cap. */
export const OTEL_FLOW_INNER_LABEL_CHARS = 40;

/** Fallback per-character width (11 px UI font) when no canvas is available. */
const FALLBACK_CHAR_PX = 6.5;

let ctx: CanvasRenderingContext2D | null | undefined;

function textWidth(text: string, font: string): number {
  if (ctx === undefined) {
    ctx =
      typeof document === 'undefined'
        ? null
        : document.createElement('canvas').getContext('2d');
  }
  if (ctx === null) return text.length * FALLBACK_CHAR_PX;
  ctx.font = font;
  return ctx.measureText(text).width;
}

/**
 * `label` cut with `…` so that `label + ' ' + suffix` fits in `maxPx`; the whole label when it
 * fits. Keeps at least one character.
 */
export function fitFlowLabel(
  label: string,
  suffix: string,
  maxPx: number,
  font: string,
): string {
  const tail = ` ${suffix}`;
  if (textWidth(label + tail, font) <= maxPx) return label;
  let lo = 1;
  let hi = label.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (textWidth(`${label.slice(0, mid)}…${tail}`, font) <= maxPx) lo = mid;
    else hi = mid - 1;
  }
  return `${label.slice(0, Math.max(1, lo))}…`;
}
