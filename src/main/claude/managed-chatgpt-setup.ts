/**
 * Owns the process-wide ChatGPT setup transaction. Renderer reloads can create a new local click
 * guard while the old IPC request is still running, so the main process must be the authoritative
 * single-flight boundary.
 */
export class ManagedChatGptGlobalSetupCoordinator<T> {
  private inFlight?: Promise<T>;

  public run(operation: () => Promise<T>): Promise<T> {
    if (this.inFlight) {
      return this.inFlight;
    }

    const request = Promise.resolve().then(operation);
    this.inFlight = request;
    void request.then(
      () => this.release(request),
      () => this.release(request),
    );
    return request;
  }

  private release(request: Promise<T>): void {
    if (this.inFlight === request) {
      this.inFlight = undefined;
    }
  }
}
