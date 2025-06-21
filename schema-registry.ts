/**
 * @fileoverview Event schema registry for validation and versioning
 */

import type { EventSchema, Result } from './types.ts';
import { ValidationError, SchemaVersionError } from './errors.ts';

/**
 * Registry for managing event schemas with validation and versioning
 */
export class EventSchemaRegistry {
  private schemas: Map<string, EventSchema>;

  constructor(schemas: Map<string, EventSchema> = new Map()) {
    this.schemas = schemas;
  }

  /**
   * Register a new event schema
   */
  register<T>(schema: EventSchema<T>): void {
    this.schemas.set(schema.event, schema);
  }

  /**
   * Check if schema exists for event
   */
  hasSchema(event: string): boolean {
    return this.schemas.has(event);
  }

  /**
   * Get schema version for event
   */
  getVersion(event: string): number | undefined {
    return this.schemas.get(event)?.version;
  }

  /**
   * Validate event payload against schema
   */
  validate<T>(event: string, payload: unknown): Result<T> {
    const schema = this.schemas.get(event);
    if (!schema) {
      return { ok: true, value: payload as T };
    }

    try {
      const validated = schema.validate(payload);
      return { ok: true, value: validated as T };
    } catch (error) {
      const validationError = new ValidationError(
        `Validation failed for event ${event}`,
        event,
        [error instanceof Error ? error.message : String(error)]
      );
      return { ok: false, error: validationError };
    }
  }

  /**
   * Validate and upgrade event payload if needed
   */
  validateWithUpgrade<T>(
    event: string,
    payload: unknown,
    version?: number
  ): Result<T> {
    const schema = this.schemas.get(event);
    if (!schema) {
      return { ok: true, value: payload as T };
    }

    // Check version
    if (version !== undefined && version !== schema.version) {
      if (schema.upgrade && version < schema.version) {
        try {
          const upgraded = schema.upgrade(payload, version);
          return this.validate(event, upgraded);
        } catch (error) {
          const versionError = new SchemaVersionError(
            `Failed to upgrade event from version ${version} to ${schema.version}`,
            event,
            schema.version,
            version
          );
          return { ok: false, error: versionError };
        }
      } else {
        const versionError = new SchemaVersionError(
          `Schema version mismatch`,
          event,
          schema.version,
          version
        );
        return { ok: false, error: versionError };
      }
    }

    return this.validate(event, payload);
  }

  /**
   * Get all registered event types
   */
  getRegisteredEvents(): string[] {
    return Array.from(this.schemas.keys());
  }

  /**
   * Export schema definitions
   */
  exportSchemas(): Record<string, { event: string; version: number }> {
    const exported: Record<string, { event: string; version: number }> = {};
    
    for (const [event, schema] of this.schemas) {
      exported[event] = {
        event: schema.event,
        version: schema.version,
      };
    }

    return exported;
  }
}

/**
 * Helper function to create a schema with Zod
 */
export function createZodSchema<T>(
  event: string,
  version: number,
  zodSchema: { parse: (data: unknown) => T },
  upgrade?: (payload: unknown, fromVersion: number) => T
): EventSchema<T> {
  return {
    event,
    version,
    validate: (payload: unknown) => zodSchema.parse(payload),
    upgrade,
  };
}

/**
 * Helper function to create a simple schema with custom validation
 */
export function createSchema<T>(
  event: string,
  version: number,
  validate: (payload: unknown) => T,
  upgrade?: (payload: unknown, fromVersion: number) => T
): EventSchema<T> {
  return {
    event,
    version,
    validate,
    upgrade,
  };
}