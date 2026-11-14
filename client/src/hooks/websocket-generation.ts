interface CurrentConnectionInput<T> {
  socket: T;
  generation: number;
  currentSocket: T | null;
  currentGeneration: number;
  disposed: boolean;
}

export function isCurrentWebSocketConnection<T>(input: CurrentConnectionInput<T>): boolean {
  return !input.disposed
    && input.socket === input.currentSocket
    && input.generation === input.currentGeneration;
}
