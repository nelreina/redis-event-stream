/**
 * @fileoverview Metrics collection for monitoring and observability
 */

import type { StreamMetrics } from './types.ts';

/**
 * Metrics collector for stream operations
 */
export class MetricsCollector {
  private metrics: StreamMetrics = {
    messagesPublished: 0,
    messagesConsumed: 0,
    messagesAcknowledged: 0,
    messagesFailed: 0,
    consumerLag: 0,
    processingTimeMs: [],
  };

  private eventMetrics = new Map<string, {
    published: number;
    consumed: number;
    acknowledged: number;
    failed: number;
    avgProcessingTimeMs: number;
  }>();

  private readonly maxProcessingTimeSamples = 1000;

  /**
   * Record a published message
   */
  recordPublish(event: string): void {
    this.metrics.messagesPublished++;
    this.incrementEventMetric(event, 'published');
  }

  /**
   * Record a consumed message
   */
  recordConsume(event: string, processingTimeMs: number): void {
    this.metrics.messagesConsumed++;
    this.metrics.processingTimeMs.push(processingTimeMs);
    
    // Keep only recent samples
    if (this.metrics.processingTimeMs.length > this.maxProcessingTimeSamples) {
      this.metrics.processingTimeMs.shift();
    }

    this.incrementEventMetric(event, 'consumed');
    this.updateEventProcessingTime(event, processingTimeMs);
  }

  /**
   * Record an acknowledged message
   */
  recordAck(event: string): void {
    this.metrics.messagesAcknowledged++;
    this.incrementEventMetric(event, 'acknowledged');
  }

  /**
   * Record a not-acknowledged message
   */
  recordNack(event: string): void {
    this.incrementEventMetric(event, 'failed');
  }

  /**
   * Record a failed message
   */
  recordError(event: string): void {
    this.metrics.messagesFailed++;
    this.incrementEventMetric(event, 'failed');
  }

  /**
   * Update consumer lag
   */
  updateLag(lag: number): void {
    this.metrics.consumerLag = lag;
  }

  /**
   * Get current metrics
   */
  getMetrics(): StreamMetrics {
    return { ...this.metrics };
  }

  /**
   * Get metrics for specific event
   */
  getEventMetrics(event: string) {
    return this.eventMetrics.get(event);
  }

  /**
   * Get all event metrics
   */
  getAllEventMetrics() {
    return new Map(this.eventMetrics);
  }

  /**
   * Calculate statistics
   */
  getStatistics() {
    const processingTimes = this.metrics.processingTimeMs;
    const avgProcessingTime = processingTimes.length > 0
      ? processingTimes.reduce((a, b) => a + b, 0) / processingTimes.length
      : 0;

    const p95ProcessingTime = this.calculatePercentile(processingTimes, 0.95);
    const p99ProcessingTime = this.calculatePercentile(processingTimes, 0.99);

    return {
      totalPublished: this.metrics.messagesPublished,
      totalConsumed: this.metrics.messagesConsumed,
      totalAcknowledged: this.metrics.messagesAcknowledged,
      totalFailed: this.metrics.messagesFailed,
      successRate: this.metrics.messagesConsumed > 0
        ? (this.metrics.messagesAcknowledged / this.metrics.messagesConsumed) * 100
        : 0,
      avgProcessingTimeMs: avgProcessingTime,
      p95ProcessingTimeMs: p95ProcessingTime,
      p99ProcessingTimeMs: p99ProcessingTime,
      currentLag: this.metrics.consumerLag,
    };
  }

  /**
   * Reset all metrics
   */
  reset(): void {
    this.metrics = {
      messagesPublished: 0,
      messagesConsumed: 0,
      messagesAcknowledged: 0,
      messagesFailed: 0,
      consumerLag: 0,
      processingTimeMs: [],
    };
    this.eventMetrics.clear();
  }

  /**
   * Export metrics in Prometheus format
   */
  toPrometheusFormat(prefix = 'redis_event_stream'): string {
    const lines: string[] = [];
    const stats = this.getStatistics();

    // Counter metrics
    lines.push(`# HELP ${prefix}_messages_published_total Total number of messages published`);
    lines.push(`# TYPE ${prefix}_messages_published_total counter`);
    lines.push(`${prefix}_messages_published_total ${stats.totalPublished}`);

    lines.push(`# HELP ${prefix}_messages_consumed_total Total number of messages consumed`);
    lines.push(`# TYPE ${prefix}_messages_consumed_total counter`);
    lines.push(`${prefix}_messages_consumed_total ${stats.totalConsumed}`);

    lines.push(`# HELP ${prefix}_messages_acknowledged_total Total number of messages acknowledged`);
    lines.push(`# TYPE ${prefix}_messages_acknowledged_total counter`);
    lines.push(`${prefix}_messages_acknowledged_total ${stats.totalAcknowledged}`);

    lines.push(`# HELP ${prefix}_messages_failed_total Total number of messages failed`);
    lines.push(`# TYPE ${prefix}_messages_failed_total counter`);
    lines.push(`${prefix}_messages_failed_total ${stats.totalFailed}`);

    // Gauge metrics
    lines.push(`# HELP ${prefix}_consumer_lag Current consumer lag`);
    lines.push(`# TYPE ${prefix}_consumer_lag gauge`);
    lines.push(`${prefix}_consumer_lag ${stats.currentLag}`);

    lines.push(`# HELP ${prefix}_success_rate Message processing success rate`);
    lines.push(`# TYPE ${prefix}_success_rate gauge`);
    lines.push(`${prefix}_success_rate ${stats.successRate.toFixed(2)}`);

    // Histogram metrics
    lines.push(`# HELP ${prefix}_processing_time_ms Message processing time in milliseconds`);
    lines.push(`# TYPE ${prefix}_processing_time_ms summary`);
    lines.push(`${prefix}_processing_time_ms{quantile="0.5"} ${stats.avgProcessingTimeMs.toFixed(2)}`);
    lines.push(`${prefix}_processing_time_ms{quantile="0.95"} ${stats.p95ProcessingTimeMs.toFixed(2)}`);
    lines.push(`${prefix}_processing_time_ms{quantile="0.99"} ${stats.p99ProcessingTimeMs.toFixed(2)}`);

    // Event-specific metrics
    for (const [event, metrics] of this.eventMetrics) {
      lines.push(`${prefix}_event_published_total{event="${event}"} ${metrics.published}`);
      lines.push(`${prefix}_event_consumed_total{event="${event}"} ${metrics.consumed}`);
      lines.push(`${prefix}_event_acknowledged_total{event="${event}"} ${metrics.acknowledged}`);
      lines.push(`${prefix}_event_failed_total{event="${event}"} ${metrics.failed}`);
      lines.push(`${prefix}_event_processing_time_ms{event="${event}"} ${metrics.avgProcessingTimeMs.toFixed(2)}`);
    }

    return lines.join('\n');
  }

  /**
   * Increment event-specific metric
   */
  private incrementEventMetric(event: string, metric: keyof Omit<typeof this.eventMetrics extends Map<string, infer T> ? T : never, 'avgProcessingTimeMs'>): void {
    const current = this.eventMetrics.get(event) || {
      published: 0,
      consumed: 0,
      acknowledged: 0,
      failed: 0,
      avgProcessingTimeMs: 0,
    };

    current[metric]++;
    this.eventMetrics.set(event, current);
  }

  /**
   * Update event processing time
   */
  private updateEventProcessingTime(event: string, processingTimeMs: number): void {
    const current = this.eventMetrics.get(event) || {
      published: 0,
      consumed: 0,
      acknowledged: 0,
      failed: 0,
      avgProcessingTimeMs: 0,
    };

    // Simple moving average
    const alpha = 0.1; // Smoothing factor
    current.avgProcessingTimeMs = current.avgProcessingTimeMs * (1 - alpha) + processingTimeMs * alpha;
    
    this.eventMetrics.set(event, current);
  }

  /**
   * Calculate percentile
   */
  private calculatePercentile(values: number[], percentile: number): number {
    if (values.length === 0) return 0;
    
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.ceil(sorted.length * percentile) - 1;
    
    return sorted[index] || 0;
  }
}