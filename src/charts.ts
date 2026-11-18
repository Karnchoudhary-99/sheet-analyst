/**
 * Charts: ASCII bar charts and sparklines for the terminal, plus an
 * SVG bar chart for embedding in reports. All rendering is pure and
 * deterministic — the same groups always produce the same picture.
 *
 * Bars are proportional to the largest value (which fills the full
 * width); every value is printed next to its bar, so a zero or
 * negative value is never hidden behind an empty bar.
 */

import { formatNumber } from "./answer.js";

/** One bar: a label and the value it stands for. */
export interface Bar {
  key: string;
  value: number;
}

export interface BarChartOptions {
  /** Bar width in characters for the largest value (default 40). */
  width?: number;
  /** Format a value for the label (default: thousands-separated). */
  formatValue?: (n: number) => string;
}

const BLOCK = "█";

/** Pad a label to `width` with spaces (left-aligned). */
function pad(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - value.length));
}

/**
 * Render horizontal ASCII bars, one per group, largest first (the
 * input order is kept — callers pass groups already sorted). An
 * empty input renders "(no data)".
 */
export function renderBarChart(bars: Bar[], options: BarChartOptions = {}): string {
  if (bars.length === 0) return "(no data)";
  const width = options.width ?? 40;
  const format = options.formatValue ?? formatNumber;
  const max = Math.max(0, ...bars.map((b) => b.value));
  const labelWidth = Math.max(...bars.map((b) => b.key.length));
  return bars
    .map((b) => {
      const len = max === 0 ? 0 : Math.max(0, Math.round((b.value / max) * width));
      return `${pad(b.key, labelWidth)} ${BLOCK.repeat(len)} ${format(b.value)}`;
    })
    .join("\n");
}
