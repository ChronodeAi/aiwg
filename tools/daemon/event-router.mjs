import { EventEmitter } from 'events';

export class EventRouter extends EventEmitter {
  constructor() {
    super();
    this.eventHistory = [];
    this.deadLetterQueue = [];
    this.maxRetries = 3;
  }

  route(event) {
    this.record(event);
    this.emit('event', event);
  }

  record(event) {
    this.eventHistory.push({
      ...event,
      timestamp: new Date().toISOString()
    });

    if (this.eventHistory.length > 1000) {
      this.eventHistory = this.eventHistory.slice(-1000);
    }
  }

  // Watch delivery is awaited by FileWatcher so a busy owner cannot lose a
  // subsequent change. Legacy route() remains synchronous EventEmitter fan-out.
  async deliver(event) {
    this.record(event);
    try {
      for (const listener of this.rawListeners('event')) await listener.call(this, event);
    } catch (error) {
      this.handleFailedEvent(event, error);
      throw error;
    }
  }

  handleFailedEvent(event, error, attemptCount = 0) {
    // Scheduled owners and watcher builds share the operator recovery path.
    // Replaying through the transient DLQ would bypass the owning authority.
    if (event.source === 'watch' ||
        (event.source === 'schedule' && event.payload?.kind && event.payload.kind !== 'agent.prompt')) {
      if (!this.emit('schedule-recovery-required', { event, error })) throw error;
      return;
    }
    if (attemptCount >= this.maxRetries) {
      this.deadLetterQueue.push({
        event,
        error: error.message,
        attempts: attemptCount,
        timestamp: new Date().toISOString()
      });

      if (this.deadLetterQueue.length > 100) {
        this.deadLetterQueue = this.deadLetterQueue.slice(-100);
      }

      this.emit('event-failed', { event, error });
    } else {
      setTimeout(() => {
        this.handleFailedEvent(event, error, attemptCount + 1);
      }, Math.pow(2, attemptCount) * 1000);
    }
  }

  getEventHistory(limit = 50) {
    return this.eventHistory.slice(-limit);
  }

  getDeadLetterQueue() {
    return [...this.deadLetterQueue];
  }

  clearHistory() {
    this.eventHistory = [];
  }

  clearDeadLetterQueue() {
    this.deadLetterQueue = [];
  }
}

export default EventRouter;
