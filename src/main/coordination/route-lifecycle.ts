export type ClaudeRouteKind = 'ccr' | 'direct' | 'managed-chatgpt' | 'managed-subscription';

export interface RouteReservationToken {
  generation: number;
  routeKind: ClaudeRouteKind;
  sessionId: string;
}

interface StopWhenUnusedInput {
  excludedSessionId?: string;
  hasActiveUser: (routeKind: ClaudeRouteKind, excludedSessionId?: string) => boolean;
  isServiceRunning: () => Promise<boolean>;
  routeKind: ClaudeRouteKind;
  stop: () => Promise<void>;
}

/** Serialises shared route start/stop work while synchronous reservations protect pending launches. */
export class RouteLifecycleCoordinator {
  private generation = 0;
  private queue: Promise<void> = Promise.resolve();
  private readonly reservations = new Map<string, RouteReservationToken>();

  public reserve(sessionId: string, routeKind: ClaudeRouteKind): RouteReservationToken {
    const token = {
      generation: this.generation + 1,
      routeKind,
      sessionId,
    };
    this.generation = token.generation;
    this.reservations.set(sessionId, token);
    return token;
  }

  public release(token: RouteReservationToken): boolean {
    if (this.reservations.get(token.sessionId) !== token) {
      return false;
    }
    this.reservations.delete(token.sessionId);
    return true;
  }

  public clear(): void {
    this.reservations.clear();
  }

  public hasReservation(routeKind: ClaudeRouteKind, excludedSessionId?: string): boolean {
    return [...this.reservations.values()].some(
      (reservation) =>
        reservation.sessionId !== excludedSessionId && reservation.routeKind === routeKind,
    );
  }

  public runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.catch(() => undefined).then(operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  public stopWhenUnused(input: StopWhenUnusedInput): Promise<boolean> {
    return this.runExclusive(async () => {
      if (this.hasUser(input)) {
        return false;
      }
      if (!(await input.isServiceRunning()) || this.hasUser(input)) {
        return false;
      }
      await input.stop();
      return true;
    });
  }

  private hasUser(input: StopWhenUnusedInput): boolean {
    return (
      input.hasActiveUser(input.routeKind, input.excludedSessionId) ||
      this.hasReservation(input.routeKind, input.excludedSessionId)
    );
  }
}
