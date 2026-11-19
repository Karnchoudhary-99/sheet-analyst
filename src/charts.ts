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
import type { QueryResult } from "./engine.js";

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

/**
 * Render a chart for a query result: time-bucketed groups become a
 * line chart (the shape over time is the point), other groups become
 * a bar chart, and everything else has no chart (null) — a single
 * number or a table of rows is already the answer, and inventing a
 * chart for it would add noise, not information.
 */
export function renderResultChart(
  result: QueryResult,
  options: BarChartOptions = {},
): string | null {
  if (result.kind !== "groups") return null;
  if (result.bucket) return renderLineChart(result.groups, options);
  return renderBarChart(result.groups, options);
}

/**
 * Render the same group result as an SVG chart, or null when the
 * result has no chart. Time-bucketed groups render as a line chart.
 */
export function renderResultChartSvg(
  result: QueryResult,
  options: SvgChartOptions = {},
): string | null {
  if (result.kind !== "groups") return null;
  if (result.bucket) return renderLineChartSvg(result.groups, options);
  return renderBarChartSvg(result.groups, options);
}

export interface LineChartOptions {
  /** Plot width in characters for ASCII (default 60). */
  width?: number;
  /** Plot height in rows for ASCII (default 10). */
  height?: number;
  /** Format a value for the axis labels (default: thousands-separated). */
  formatValue?: (n: number) => string;
}

/**
 * Render a series as an ASCII line chart: one point per entry in
 * input order, connected by slope characters, with the max value
 * labelled at the top and the min at the bottom. A flat series
 * renders as a horizontal line through the middle; a single point
 * renders as one dot. An empty input renders "(no data)".
 */
export function renderLineChart(points: Bar[], options: LineChartOptions = {}): string {
  if (points.length === 0) return "(no data)";
  const width = options.width ?? 60;
  const height = options.height ?? 10;
  const format = options.formatValue ?? formatNumber;
  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const xs = points.map((_, i) =>
    points.length === 1
      ? Math.floor(width / 2)
      : Math.round((i * (width - 1)) / (points.length - 1)),
  );
  const yOf = (v: number): number =>
    max === min
      ? Math.floor(height / 2)
      : height - 1 - Math.round(((v - min) / (max - min)) * (height - 1));
  const grid: string[][] = Array.from({ length: height }, () =>
    Array<string>(width).fill(" "),
  );
  for (let i = 0; i + 1 < points.length; i++) {
    const x0 = xs[i]!;
    const x1 = xs[i + 1]!;
    const y0 = yOf(points[i]!.value);
    const y1 = yOf(points[i + 1]!.value);
    for (let x = x0; x <= x1; x++) {
      const t = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
      const y = Math.round(y0 + (y1 - y0) * t);
      // Row 0 is the top, so a rising value has y1 < y0.
      grid[y]![x] = y1 === y0 ? "─" : y1 < y0 ? "╱" : "╲";
    }
  }
  points.forEach((p, i) => {
    grid[yOf(p.value)]![xs[i]!] = "●";
  });
  const labelWidth = Math.max(format(max).length, format(min).length);
  const lines = grid.map((row, r) => {
    const label = r === 0 ? format(max) : r === height - 1 ? format(min) : "";
    return `${label.padStart(labelWidth)} │${row.join("")}`;
  });
  const axis = `${" ".repeat(labelWidth)} └${"─".repeat(width)}`;
  const first = points[0]!.key;
  const last = points[points.length - 1]!.key;
  const xLabel =
    points.length === 1
      ? `${" ".repeat(labelWidth + 2)}${first}`
      : `${" ".repeat(labelWidth + 2)}${first}${" ".repeat(Math.max(1, width - first.length - last.length))}${last}`;
  return [...lines, axis, xLabel].join("\n");
}

/**
 * Render a series as an SVG line chart: a polyline through the
 * points with a dot per point, min/max on the y-axis and the first
 * and last (or every, when there are few) keys on the x-axis.
 * Labels are XML-escaped like the bar chart's.
 */
export function renderLineChartSvg(points: Bar[], options: SvgChartOptions = {}): string {
  const width = options.width ?? 640;
  const height = 320;
  const format = options.formatValue ?? formatNumber;
  const padLeft = 70;
  const padRight = 20;
  const padTop = options.title ? 40 : 16;
  const padBottom = 40;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;
  const values = points.map((p) => p.value);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const xOf = (i: number): number =>
    points.length === 1
      ? padLeft + plotWidth / 2
      : padLeft + (i / (points.length - 1)) * plotWidth;
  const yOf = (v: number): number =>
    max === min
      ? padTop + plotHeight / 2
      : padTop + plotHeight - ((v - min) / (max - min)) * plotHeight;
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="sans-serif" font-size="13">`,
  ];
  if (options.title) {
    parts.push(`<text x="8" y="20" font-size="15" font-weight="bold">${escapeXml(options.title)}</text>`);
  }
  // Y-axis labels.
  parts.push(
    `<text x="${padLeft - 8}" y="${padTop + 4}" text-anchor="end">${escapeXml(format(max))}</text>`,
    `<text x="${padLeft - 8}" y="${padTop + plotHeight + 4}" text-anchor="end">${escapeXml(format(min))}</text>`,
    `<line x1="${padLeft}" y1="${padTop}" x2="${padLeft}" y2="${padTop + plotHeight}" stroke="#94a3b8"/>`,
    `<line x1="${padLeft}" y1="${padTop + plotHeight}" x2="${padLeft + plotWidth}" y2="${padTop + plotHeight}" stroke="#94a3b8"/>`,
  );
  if (points.length > 0) {
    const line = points
      .map((p, i) => `${xOf(i).toFixed(1)},${yOf(p.value).toFixed(1)}`)
      .join(" ");
    parts.push(
      `<polyline points="${line}" fill="none" stroke="#2563eb" stroke-width="2"/>`,
    );
    points.forEach((p, i) => {
      parts.push(
        `<circle cx="${xOf(i).toFixed(1)}" cy="${yOf(p.value).toFixed(1)}" r="4" fill="#2563eb"/>`,
      );
    });
    // X labels: every key when there are few, else first and last.
    const labelled = points.length <= 12 ? points : [points[0]!, points[points.length - 1]!];
    const labelledIdx = points.length <= 12
      ? points.map((_, i) => i)
      : [0, points.length - 1];
    labelled.forEach((p, j) => {
      const i = labelledIdx[j]!;
      const anchor = i === 0 ? "start" : i === points.length - 1 ? "end" : "middle";
      parts.push(
        `<text x="${xOf(i).toFixed(1)}" y="${padTop + plotHeight + 20}" text-anchor="${anchor}">${escapeXml(p.key)}</text>`,
      );
    });
  }
  parts.push("</svg>");
  return parts.join("\n");
}

export interface SvgChartOptions {
  /** Chart width in px (default 640). */
  width?: number;
  /** Bar height in px (default 28). */
  barHeight?: number;
  /** Chart title, rendered above the bars. */
  title?: string;
  /** Format a value for the label (default: thousands-separated). */
  formatValue?: (n: number) => string;
}

/** Escape text for an XML attribute or element body. */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Render the same bars as a standalone SVG document: one horizontal
 * bar per group with its label on the left and its value on the
 * right. Labels are XML-escaped, so a group named `<script>` cannot
 * break out of the document.
 */
export function renderBarChartSvg(bars: Bar[], options: SvgChartOptions = {}): string {
  const width = options.width ?? 640;
  const barHeight = options.barHeight ?? 28;
  const gap = 8;
  const labelWidth = 140;
  const valueWidth = 90;
  const format = options.formatValue ?? formatNumber;
  const max = Math.max(0, ...bars.map((b) => b.value));
  const plotWidth = width - labelWidth - valueWidth;
  const titleHeight = options.title ? 28 : 0;
  const height = titleHeight + bars.length * (barHeight + gap) + gap;
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="sans-serif" font-size="13">`,
  ];
  if (options.title) {
    parts.push(`<text x="8" y="20" font-size="15" font-weight="bold">${escapeXml(options.title)}</text>`);
  }
  bars.forEach((b, i) => {
    const y = titleHeight + gap + i * (barHeight + gap);
    const len = max === 0 ? 0 : Math.max(0, (b.value / max) * plotWidth);
    parts.push(
      `<text x="8" y="${y + barHeight / 2 + 4}">${escapeXml(b.key)}</text>`,
      `<rect x="${labelWidth}" y="${y}" width="${len.toFixed(1)}" height="${barHeight}" fill="#2563eb"/>`,
      `<text x="${labelWidth + len + 6}" y="${y + barHeight / 2 + 4}">${escapeXml(format(b.value))}</text>`,
    );
  });
  parts.push("</svg>");
  return parts.join("\n");
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
