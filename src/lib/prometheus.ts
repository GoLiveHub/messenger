/**
 * Minimal Prometheus metrics registry in text exposition format.
 *
 * No external deps: counters / gauges / histograms with label support,
 * exportable via `/metrics` in the standard Prometheus text format.
 */

interface MetricLabel {
  name: string;
  value: string;
}

interface Counter {
  type: 'counter';
  name: string;
  help: string;
  labels: MetricLabel[];
}

interface Gauge {
  type: 'gauge';
  name: string;
  help: string;
  labels: MetricLabel[];
}

interface HistogramBucket {
  le: number;
  count: number;
}

interface Histogram {
  type: 'histogram';
  name: string;
  help: string;
  labels: MetricLabel[];
  buckets: HistogramBucket[];
  sum: number;
  count: number;
}

// Registered metrics keyed by `name#{labels}` for interest tracking
const counters = new Map<string, Counter>();
const gauges = new Map<string, Gauge>();
const histograms = new Map<string, Histogram>();

function labelKey(name: string, labels: Record<string, string>): string {
  const parts = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${escapeLabel(v)}"`);
  return parts.length ? `${name}{${parts.join(',')}}` : name;
}

function escapeLabel(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

export function incCounter(name: string, help: string, labels: Record<string, string> = {}, delta = 1): void {
  const key = labelKey(name, labels);
  let c = counters.get(key);
  if (!c) {
    c = { type: 'counter', name, help, labels: Object.entries(labels).map(([n, v]) => ({ name: n, value: v })) };
    counters.set(key, c);
  } else {
    c.labels = Object.entries(labels).map(([n, v]) => ({ name: n, value: v }));
  }
  let value = getCounterValue(c) ?? 0;
  value += delta;
  setCounterValue(c, value);
}

function setCounterValue(c: Counter, value: number): void {
  (c as any).value = value;
}
function getCounterValue(c: Counter): number {
  return (c as any).value ?? 0;
}

export function setGauge(name: string, value: number, help: string, labels: Record<string, string> = {}): void {
  const key = labelKey(name, labels);
  let g = gauges.get(key);
  if (!g) {
    g = { type: 'gauge', name, help, labels: Object.entries(labels).map(([n, v]) => ({ name: n, value: v })) };
    gauges.set(key, g);
  }
  g.labels = Object.entries(labels).map(([n, v]) => ({ name: n, value: v }));
  (g as any).value = value;
}

export function incGauge(name: string, help: string, labels: Record<string, string> = {}, delta = 1): void {
  const key = labelKey(name, labels);
  let g = gauges.get(key);
  if (!g) {
    g = { type: 'gauge', name, help, labels: Object.entries(labels).map(([n, v]) => ({ name: n, value: v })) };
    gauges.set(key, g);
  }
  (g as any).value = ((g as any).value ?? 0) + delta;
}

export function observeHistogram(name: string, value: number, help: string, buckets: number[] = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10], labels: Record<string, string> = {}): void {
  const key = labelKey(name, labels);
  let h = histograms.get(key);
  if (!h) {
    h = { type: 'histogram', name, help, labels: Object.entries(labels).map(([n, v]) => ({ name: n, value: v })), buckets: buckets.map((le) => ({ le, count: 0 })), sum: 0, count: 0 };
    histograms.set(key, h);
  }
  h.sum += value;
  h.count += 1;
  for (const b of h.buckets) {
    if (value <= b.le) b.count += 1;
  }
}

function formatLabelSuffix(labels: MetricLabel[]): string {
  if (!labels.length) return '';
  return `{${labels.map((l) => `${l.name}="${escapeLabel(l.value)}"`).join(',')}}`;
}

export function renderMetrics(): string {
  const lines: string[] = [];
  for (const c of counters.values()) {
    lines.push(`# HELP ${c.name} ${c.help}`);
    lines.push(`# TYPE ${c.name} counter`);
    lines.push(`${c.name}${formatLabelSuffix(c.labels)} ${getCounterValue(c)}`);
  }
  for (const g of gauges.values()) {
    lines.push(`# HELP ${g.name} ${g.help}`);
    lines.push(`# TYPE ${g.name} gauge`);
    lines.push(`${g.name}${formatLabelSuffix(g.labels)} ${(g as any).value ?? 0}`);
  }
  for (const h of histograms.values()) {
    lines.push(`# HELP ${h.name} ${h.help}`);
    lines.push(`# TYPE ${h.name} histogram`);
    for (const b of h.buckets) {
      lines.push(`${h.name}_bucket${formatLabelSuffix(h.labels)}{le="${b.le}"} ${b.count}`);
    }
    lines.push(`${h.name}_sum${formatLabelSuffix(h.labels)} ${h.sum}`);
    lines.push(`${h.name}_count${formatLabelSuffix(h.labels)} ${h.count}`);
  }
  return lines.join('\n') + '\n';
}

/** Clear all metrics (used by tests). */
export function resetMetrics(): void {
  counters.clear();
  gauges.clear();
  histograms.clear();
}