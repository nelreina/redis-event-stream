class RedisEventStream {
  constructor(client, streamKeyName, groupName, options = {}) {
    this.client = client;
    this.logger = options.logger || console;
    this.streamKeyName = streamKeyName;
    this.groupName = groupName;
    this.defaultOptions = {
      blockMs: 30000,
      autoAck: false,
      startID: "$",
      consumer: "consumer-1",
    };
  }

  async createStream(options = {}) {
    const streamOptions = { ...this.defaultOptions, ...options };
    const { startID, consumer } = streamOptions;

    // Create group and consumer
    const groupOK = await this._createGroup(startID);
    if (!groupOK) return null;

    const consumerOK = await this._createConsumer(
      this.streamKeyName,
      this.groupName,
      consumer,
    );
    if (!consumerOK) return null;

    // Create dedicated connection for stream
    const streamClient = this.client.duplicate();
    await streamClient.connect();

    return new StreamHandler(
      streamClient,
      this.streamKeyName,
      this.groupName,
      streamOptions,
      this.logger,
    );
  }

  async publish(event, aggregateId, data) {
    if (!this.client.isOpen) {
      await this.client.connect();
    }

    const eventData = {
      event,
      aggregateId,
      timestamp: this._getLocalTimestamp(),
      payload: JSON.stringify(data),
      serviceName: this.groupName,
    };

    return await this.client.xAdd(this.streamKeyName, "*", eventData);
  }

  async _createGroup(startID) {
    try {
      await this.client.xGroupCreate(
        this.streamKeyName,
        this.groupName,
        startID,
        {
          MKSTREAM: true,
        },
      );
      this.logger.info(
        `${this.groupName} created for key: ${this.streamKeyName}!`,
      );
      const info = await this.client.xInfoGroups(this.streamKeyName);
      this.logger.info(JSON.stringify(info));
      return true;
    } catch (error) {
      if (error.message.includes("already exists")) {
        const info = await this.client.xInfoGroups(this.streamKeyName);
        this.logger.info(JSON.stringify(info));
        return true;
      } else {
        this.logger.error(error.message);
        return false;
      }
    }
  }

  async _createConsumer(consumer) {
    try {
      await this.client.xGroupCreateConsumer(
        this.streamKeyName,
        this.groupName,
        consumer,
      );
      const info = await this.client.xInfoConsumers(
        this.streamKeyName,
        this.groupName,
      );
      this.logger.info(JSON.stringify(info));
      return true;
    } catch (error) {
      this.logger.error(
        "LOG:  ~ file: redis-stream.js ~ line 9 ~ error",
        error.message,
      );
      return false;
    }
  }

  _getLocalTimestamp() {
    const options = {
      timeZone: "America/Curacao",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      fractionalSecondDigits: 3,
      hour12: false,
    };

    const date = new Date();
    const timestamp = date
      .toLocaleString("sv-SE", options)
      .replace(" ", "T")
      .replace(",", "")
      .replace(/(\d{2}:\d{2}:\d{2})/, "$1.");
    return timestamp;
  }
}

class StreamHandler {
  constructor(client, streamKey, groupName, options, logger) {
    this.client = client;
    this.streamKey = streamKey;
    this.groupName = groupName;
    this.options = options;
    this.logger = logger;
  }

  async ack(messageId) {
    return await this.client.xAck(
      this.streamKey,
      this.groupName,
      messageId,
    );
  }

  async subscribe(eventHandler, filterEvents = null) {
    const { blockMs, consumer } = this.options;

    try {
      while (true) {
        const messages = await this.client.xReadGroup(
          this.groupName,
          consumer,
          { key: this.streamKey, id: ">" },
          { BLOCK: blockMs, COUNT: 1 },
        );

        if (!messages) continue;

        const [msg] = messages;
        const [streamData] = msg.messages;
        const { id, message } = streamData;

        // Parse message payload
        let payload = message.payload;
        try {
          payload = JSON.parse(payload);
        } catch (_) {
          // Payload is not JSON
        }

        // Check if we should process this event
        if (!filterEvents || filterEvents.includes(message.event)) {
          await eventHandler({
            streamId: id,
            event: message.event,
            aggregateId: message.aggregateId,
            timestamp: message.timestamp,
            serviceName: message.serviceName,
            mimeType: message.mimeType,
            payload,
            ack: () => this.ack(id),
          });
        } else {
          await this.ack(id);
        }
      }
    } catch (error) {
      this.logger.error("Stream processing error:", error);
      throw error;
    }
  }
}

export default RedisEventStream;
