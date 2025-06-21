/**
 * @fileoverview Connection pool for Redis clients
 */

import type { RedisClient, Result } from './types.ts';
import { ConnectionError } from './errors.ts';

/**
 * Connection pool for managing multiple Redis connections
 */
export class ConnectionPool {
  private connections: RedisClient[] = [];
  private available: RedisClient[] = [];
  private waitQueue: Array<(client: RedisClient) => void> = [];

  constructor(
    private baseClient: RedisClient,
    private size: number
  ) {}

  /**
   * Initialize the connection pool
   */
  async initialize(): Promise<Result<void>> {
    try {
      for (let i = 0; i < this.size; i++) {
        const client = this.baseClient.duplicate();
        await client.connect();
        this.connections.push(client);
        this.available.push(client);
      }
      return { ok: true, value: undefined };
    } catch (error) {
      return {
        ok: false,
        error: new ConnectionError(
          `Failed to initialize connection pool`,
          error as Error
        ),
      };
    }
  }

  /**
   * Get a connection from the pool
   */
  async getConnection(): Promise<Result<RedisClient>> {
    // If connections available, return one
    const client = this.available.pop();
    if (client) {
      return { ok: true, value: client };
    }

    // Otherwise wait for one to become available
    return new Promise((resolve) => {
      this.waitQueue.push((client) => {
        resolve({ ok: true, value: client });
      });
    });
  }

  /**
   * Release a connection back to the pool
   */
  releaseConnection(client: RedisClient): void {
    const waiter = this.waitQueue.shift();
    if (waiter) {
      waiter(client);
    } else {
      this.available.push(client);
    }
  }

  /**
   * Execute a function with a pooled connection
   */
  async withConnection<T>(
    fn: (client: RedisClient) => Promise<T>
  ): Promise<Result<T>> {
    const connectionResult = await this.getConnection();
    if (!connectionResult.ok) {
      return { ok: false, error: connectionResult.error };
    }

    const client = connectionResult.value;
    try {
      const result = await fn(client);
      return { ok: true, value: result };
    } catch (error) {
      return { ok: false, error: error as Error };
    } finally {
      this.releaseConnection(client);
    }
  }

  /**
   * Close all connections in the pool
   */
  async close(): Promise<void> {
    await Promise.all(
      this.connections.map((client) => client.quit())
    );
    this.connections = [];
    this.available = [];
    this.waitQueue = [];
  }

  /**
   * Get pool statistics
   */
  getStats() {
    return {
      total: this.connections.length,
      available: this.available.length,
      inUse: this.connections.length - this.available.length,
      waiting: this.waitQueue.length,
    };
  }
}