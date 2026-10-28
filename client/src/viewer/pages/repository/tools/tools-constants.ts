/**
 * Client constants of the repository Tools/MCP tab (DD-22) and its localStorage keys (DD-21).
 */

/** Height above which a long output / input block collapses behind "Show all". */
export const COLLAPSE_HEIGHT_PX = 400;
/** Debounce of the calls search input before it reaches the URL and the server. */
export const SEARCH_DEBOUNCE_MS = 300;
/** Summary refetch interval while `pendingSessions > 0`. */
export const PENDING_REFETCH_MS = 10000;

/** Tools tree pane: default width, minimum width and the width of the collapsed rail. */
export const TREE_WIDTH_DEFAULT = 280;
export const TREE_WIDTH_MIN = 200;
export const TREE_RAIL_WIDTH = 28;

/** Calls table pane: default and minimum width. */
export const TABLE_WIDTH_DEFAULT = 560;
export const TABLE_WIDTH_MIN = 360;
/** Details pane minimum width (it takes the remaining space). */
export const DETAILS_MIN_WIDTH = 360;

/** Error % colour thresholds: grey below amber, amber below red, red at and above red. */
export const ERROR_PCT_AMBER = 5;
export const ERROR_PCT_RED = 15;

/** localStorage keys of the pane layout (DD-21). */
export const TOOLS_TREE_WIDTH_KEY = 'artisyn:toolsTab:treeWidth';
export const TOOLS_TABLE_WIDTH_KEY = 'artisyn:toolsTab:tableWidth';
export const TOOLS_TREE_COLLAPSED_KEY = 'artisyn:toolsTab:treeCollapsed';
