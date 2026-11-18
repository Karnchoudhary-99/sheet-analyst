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

export interface HistogramBin {
  /** Inclusive lower edge. */
  from: number;
  /** Exclusive upper edge (the last bin includes its max). */
  to: number;
  count: number;
}

/**
 * Bucket `values` into `bins` equal-width bins spanning [min, max].
 * An empty input yields no bins; a single distinct value yields one
 * bin holding everything. The maximum value always lands in the last
 * bin, never past the edge.
 */
export function histogram(values: number[], bins = 10): HistogramBin[] {
  if (values.length === 0 || bins < 1) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return [{ from: min, to: max, count: values.length }];
  const width = (max - min) / bins;
  const out: HistogramBin[] = Array.from({ length: bins }, (_, i) => ({
    from: min + i * width,
    to: min + (i + 1) * width,
    count: 0,
  }));
  for (const v of values) {
    const idx = Math.min(bins - 1, Math.floor((v - min) / width));
    out[idx]!.count += 1;
  }
  return out;
}

/** Render histogram bins as horizontal ASCII bars with range labels. */
export function renderHistogram(
  bins: HistogramBin[],
  options: BarChartOptions = {},
): string {
  if (bins.length === 0) return "(no data)";
  const width = options.width ?? 40;
  const format = options.formatValue ?? formatNumber;
  const max = Math.max(0, ...bins.map((b) => b.count));
  return bins
    .map((b) => {
      const label = `${format(b.from)}–${format(b.to)}`;
      const len = max === 0 ? 0 : Math.round((b.count / max) * width);
      return `${label} ${BLOCK.repeat(len)} ${b.count}`;
    })
    .join("\n");
}

const SPARK_LEVELS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/**
 * A one-line sparkline for a numeric series (e.g. revenue over
 * time): each value becomes one block character scaled between the
 * series min and max. A flat series renders as mid-level blocks;
 * an empty series renders "(no data)".
 */
export function sparkline(values: number[]): string {
  if (values.length === 0) return "(no data)";
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return SPARK_LEVELS[3]!.repeat(values.length);
  return values
    .map((v) => {
      const idx = Math.round(((v - min) / (max - min)) * (SPARK_LEVELS.length - 1));
      return SPARK_LEVELS[idx]!;
    })
    .join("");
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
