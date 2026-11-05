/**
 * The tiny token chart inside the `Live` header button (2026-11-05): one blue bar per minute of
 * `GET /api/v1/otel/live/status → spark.tokens`, scaled to its own maximum, newest at the right,
 * in a framed box with a faint grid (a line every 5 minutes, thirds across). A missing series
 * (server before 2026-11-05) or an all-zero one draws the empty frame.
 *
 * Everything — the frame too — is drawn in the svg on whole pixels (bars and grid with
 * `crispEdges`), so it stays sharp; a CSS border would smear at 125 % display scaling.
 */
/** 8 + 16 icon + 5 gap + 63 + 8 = the 100 px button. */
const WIDTH = 63;
/** 20 of the button's 32 px; the 16 px icon centres against it. */
const HEIGHT = 20;
/** The plot inside the 1 px frame and a 1 px inset: x 2..61, y 1..19. */
const PLOT_X = 2;
const PLOT_W = 59;
const PLOT_BOTTOM = 19;
/** Plot height 18: a multiple of 3, so the grid thirds land on whole pixels. */
const PLOT_H = 18;
/** Room above the tallest bar, so it does not touch the frame. */
const HEADROOM = 2;
const BAR_W = 3;
const GAP = 1;
/** A minute with any tokens shows at least this tall, so a quiet minute is not lost. */
const MIN_BAR = 2;
/** A vertical grid line every this many bars (5 minutes). */
const GRID_EVERY = 5;

export interface SparkBar {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Bars right-aligned in the plot (the newest minute at the right edge), whole pixels. */
export function sparklineBars(values: readonly number[]): SparkBar[] {
  const max = Math.max(0, ...values);
  if (values.length === 0 || max <= 0) return [];
  const right = PLOT_X + PLOT_W;
  const n = values.length;
  return values.flatMap((v, i) => {
    if (v <= 0) return [];
    const x = right - (n - i) * (BAR_W + GAP) + GAP;
    if (x < PLOT_X) return [];
    const height = Math.max(
      MIN_BAR,
      Math.round((v / max) * (PLOT_H - HEADROOM)),
    );
    return [{ x, y: PLOT_BOTTOM - height, width: BAR_W, height }];
  });
}

export function LiveSparkline({
  values,
  live,
}: {
  values: readonly number[];
  live: boolean;
}) {
  const bars = sparklineBars(values);
  const right = PLOT_X + PLOT_W;
  const n = values.length;
  // A line in the 1 px gap before every 5th bar from the left.
  const vertical: number[] = [];
  for (let i = GRID_EVERY; i < n; i += GRID_EVERY) {
    const x = right - (n - i) * (BAR_W + GAP);
    if (x > PLOT_X) vertical.push(x);
  }
  return (
    <svg
      width={WIDTH}
      height={HEIGHT}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      // Inline, because the Button's `[&_svg]:size-4` would squash it to 16 × 16.
      style={{ width: WIDTH, height: HEIGHT }}
      className="shrink-0"
      aria-hidden="true"
      data-testid="nav-live-spark"
    >
      {/* The 1 px frame as two filled rects with whole-pixel edges under `crispEdges`: they
          land on the right pixel even a hair off-grid, where a 0.5-offset stroke can round a
          pixel inward. A small radius keeps the snapped corners from stair-stepping. */}
      <g shapeRendering="crispEdges">
        <rect
          x={0}
          y={0}
          width={WIDTH}
          height={HEIGHT}
          rx={2}
          className="fill-border"
        />
        <rect
          x={1}
          y={1}
          width={WIDTH - 2}
          height={HEIGHT - 2}
          rx={1}
          className="fill-background"
        />
      </g>
      {/* +0.5: a 1 px stroke centred on a pixel, not straddling two. */}
      <g className="stroke-border" strokeWidth={1} shapeRendering="crispEdges">
        {[PLOT_H / 3, (2 * PLOT_H) / 3].map((dy) => (
          <line
            key={`h${dy}`}
            x1={1}
            x2={WIDTH - 1}
            y1={PLOT_BOTTOM - dy + 0.5}
            y2={PLOT_BOTTOM - dy + 0.5}
          />
        ))}
        {vertical.map((x) => (
          <line
            key={`v${x}`}
            x1={x + 0.5}
            x2={x + 0.5}
            y1={1}
            y2={HEIGHT - 1}
          />
        ))}
      </g>
      <g
        className={live ? 'fill-blue-500' : 'fill-blue-300'}
        shapeRendering="crispEdges"
      >
        {bars.map((b) => (
          <rect key={b.x} x={b.x} y={b.y} width={b.width} height={b.height} />
        ))}
      </g>
    </svg>
  );
}
