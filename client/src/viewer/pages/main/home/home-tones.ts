/**
 * Muted colour tones of the Home page (ui-principles.md § Status colours and Home tones): each
 * widget has one, shown as a tinted icon chip in its header and a thin top accent on the card,
 * and the same tones code statuses inside the widgets. Pale `-50` fills, `-200` accents and
 * `-700` text keep it calm on the light theme.
 *
 * The status tones mean the same as everywhere else in the app: `amber` = needs attention /
 * warning, `red` = failure, `emerald` = healthy / success / savings, `blue` = cost (the chart
 * colour). A widget's identity tone never borrows a status tone for anything else.
 *
 * The class strings are written out in full so Tailwind's scanner keeps them.
 */
export type HomeTone =
  | 'sky'
  | 'blue'
  | 'violet'
  | 'amber'
  | 'emerald'
  | 'indigo'
  | 'slate'
  | 'teal'
  | 'red';

export interface HomeToneClasses {
  /** Header icon chip: pale fill, mid icon, faint ring. */
  chip: string;
  /** Top accent strip of a widget card (a fill: the card clips it to its rounded corners). */
  accent: string;
  /** A small status badge / pill. */
  badge: string;
  /** A coloured dot or bar fill. */
  fill: string;
  /** Icon colour inside a list line. */
  icon: string;
  /** Left rule of a group inside a widget. */
  rule: string;
}

export const HOME_TONES: Record<HomeTone, HomeToneClasses> = {
  sky: {
    chip: 'bg-sky-50 text-sky-600 ring-sky-100',
    accent: 'bg-sky-200',
    badge: 'bg-sky-50 text-sky-700 ring-sky-100',
    fill: 'bg-sky-300',
    icon: 'text-sky-500',
    rule: 'border-l-sky-200',
  },
  blue: {
    chip: 'bg-blue-50 text-blue-600 ring-blue-100',
    accent: 'bg-blue-200',
    badge: 'bg-blue-50 text-blue-700 ring-blue-100',
    fill: 'bg-blue-300',
    icon: 'text-blue-500',
    rule: 'border-l-blue-200',
  },
  violet: {
    chip: 'bg-violet-50 text-violet-600 ring-violet-100',
    accent: 'bg-violet-200',
    badge: 'bg-violet-50 text-violet-700 ring-violet-100',
    fill: 'bg-violet-300',
    icon: 'text-violet-500',
    rule: 'border-l-violet-200',
  },
  amber: {
    chip: 'bg-amber-50 text-amber-600 ring-amber-100',
    accent: 'bg-amber-200',
    badge: 'bg-amber-50 text-amber-700 ring-amber-100',
    fill: 'bg-amber-300',
    icon: 'text-amber-500',
    rule: 'border-l-amber-200',
  },
  emerald: {
    chip: 'bg-emerald-50 text-emerald-600 ring-emerald-100',
    accent: 'bg-emerald-200',
    badge: 'bg-emerald-50 text-emerald-700 ring-emerald-100',
    fill: 'bg-emerald-300',
    icon: 'text-emerald-500',
    rule: 'border-l-emerald-200',
  },
  indigo: {
    chip: 'bg-indigo-50 text-indigo-600 ring-indigo-100',
    accent: 'bg-indigo-200',
    badge: 'bg-indigo-50 text-indigo-700 ring-indigo-100',
    fill: 'bg-indigo-300',
    icon: 'text-indigo-500',
    rule: 'border-l-indigo-200',
  },
  slate: {
    chip: 'bg-slate-100 text-slate-600 ring-slate-200',
    accent: 'bg-slate-200',
    badge: 'bg-slate-100 text-slate-700 ring-slate-200',
    fill: 'bg-slate-300',
    icon: 'text-slate-500',
    rule: 'border-l-slate-200',
  },
  teal: {
    chip: 'bg-teal-50 text-teal-600 ring-teal-100',
    accent: 'bg-teal-200',
    badge: 'bg-teal-50 text-teal-700 ring-teal-100',
    fill: 'bg-teal-300',
    icon: 'text-teal-500',
    rule: 'border-l-teal-200',
  },
  red: {
    chip: 'bg-red-50 text-red-600 ring-red-100',
    accent: 'bg-red-200',
    badge: 'bg-red-50 text-red-700 ring-red-100',
    fill: 'bg-red-300',
    icon: 'text-red-500',
    rule: 'border-l-red-200',
  },
};
