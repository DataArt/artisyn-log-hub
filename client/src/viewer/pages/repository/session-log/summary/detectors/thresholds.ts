/**
 * Detector threshold constants. This is the only place these
 * literals appear: detectors and their unit tests both derive fixtures from these constants
 * rather than restating literals.
 */

/** A turn is "at the ceiling" at ≥ this fraction of the context window. */
export const CONTEXT_CEILING_WINDOW_FRACTION = 0.8;

/** `context-ceiling-pressure` fires when ≥ this share of eligible turns are at the ceiling. */
export const CONTEXT_CEILING_TURN_SHARE = 0.3;

/** `low-cache-read-ratio` fires below this cache-read ratio. */
export const LOW_CACHE_READ_RATIO_FLOOR = 0.7;

/** `low-cache-read-ratio` only fires on sessions with at least this many prompt turns. */
export const LOW_CACHE_READ_MIN_TURNS = 10;

/**
 * The change-surface detectors' firing guards.
 *
 * The **band boundaries themselves live only on the server** (`concentrationBand()`), and ship
 * as the aggregate's `band` field: CS-1 fires on `band === 'scattered'`, never on a client-side
 * `< 40` comparison. The server's small-change floor already bands any change of up to 5 files
 * `focused`, so the band check alone keeps trivially small sessions from being scolded; the
 * constants below are the extra guards for scattered-band sessions (6+ files) that still touch
 * only a few folders. None of the change-surface detectors use `critical`: a scattered
 * or multi-module change surface is routine cross-cutting work, not an emergency.
 */

/** `change-surface-spread` also requires at least this many touched folders. */
export const CHANGE_SURFACE_SCATTERED_MIN_FOLDERS = 5;

/** `change-surface-modules` fires above this many distinct top-level modules. */
export const CHANGE_SURFACE_MAX_TOP_MODULES = 4;

/** `change-surface-single-file-folders` fires above this share of single-file folders. */
export const CHANGE_SURFACE_SINGLE_FILE_FOLDER_SHARE = 0.5;

/** `change-surface-single-file-folders` also requires at least this many touched folders. */
export const CHANGE_SURFACE_SINGLE_FILE_MIN_FOLDERS = 4;
