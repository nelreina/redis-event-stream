# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Deno/Node.js library that provides Redis Streams-based event streaming capabilities. The package is published to JSR as `@nelreina/redis-stream-event`.

## Architecture

The codebase consists of two main classes in `mod.js`:

1. **RedisEventStream**: Main entry point that handles Redis client configuration, stream/group creation, and publishing events
2. **StreamHandler**: Handles subscription logic and message processing with dedicated Redis connections

Key architectural patterns:
- Uses Redis Streams with consumer groups for reliable event processing
- Creates dedicated Redis connections for streaming operations
- Supports event filtering and custom acknowledgment patterns
- Built-in stream trimming to prevent unbounded growth (default maxLength: 10000)

## Configuration Options

Default options include:
- `blockMs`: 30000 (blocking timeout for stream reads)
- `autoAck`: false (manual acknowledgment required)  
- `startID`: "$" (read from latest messages)
- `consumer`: "consumer-1"
- `timeZone`: "America/Curacao"
- `maxLength`: 10000 (stream trimming limit)
- `initLog`: true (enable initialization logging)

## Development Commands

This is a Deno project with JSR publishing:

```bash
# Add to Deno project
deno add jsr:@nelreina/redis-stream-event

# Add to Node.js project  
npx jsr add @nelreina/redis-stream-event
```

## Key Implementation Details

- Event payload is JSON stringified when published and parsed when consumed
- Timestamps use configurable timezone with Swedish locale formatting
- Stream trimming occurs after each publish operation
- Consumer groups and consumers are created automatically if they don't exist
- Supports event filtering in subscription handlers