import type { LoopSession, SessionFactory, SpawnOptions } from '../../src/web/session.js'

/**
 * A `claude` session the test drives by hand.
 *
 * The queue's whole state machine — sequencing, the shutdown ladder, the
 * failure path — is reachable through this without a pty, a terminal, or a
 * Claude Code install.
 */
export class FakeSession implements LoopSession {
  readonly options: SpawnOptions
  readonly written: string[] = []
  readonly killed: string[] = []
  readonly resized: Array<[number, number]> = []

  private readonly dataHandlers: Array<(chunk: string) => void> = []
  private readonly exitHandlers: Array<(code: number) => void> = []

  constructor(options: SpawnOptions) {
    this.options = options
  }

  write(data: string): void {
    this.written.push(data)
  }

  resize(cols: number, rows: number): void {
    this.resized.push([cols, rows])
  }

  kill(signal?: string): void {
    this.killed.push(signal ?? 'SIGTERM')
  }

  onData(fn: (chunk: string) => void): void {
    this.dataHandlers.push(fn)
  }

  onExit(fn: (code: number) => void): void {
    this.exitHandlers.push(fn)
  }

  /** Pretend the session printed something. */
  emit(chunk: string): void {
    for (const handler of this.dataHandlers) handler(chunk)
  }

  /** Pretend the session exited. */
  end(code = 0): void {
    for (const handler of this.exitHandlers) handler(code)
  }
}

export interface FakeSessions {
  sessions: FakeSession[]
  factory: SessionFactory
  /** The session spawned most recently. */
  last: () => FakeSession
}

export function fakeSessions(): FakeSessions {
  const sessions: FakeSession[] = []
  return {
    sessions,
    factory: (options) => {
      const session = new FakeSession(options)
      sessions.push(session)
      return session
    },
    last: () => {
      const session = sessions.at(-1)
      if (session === undefined) throw new Error('no session has been spawned')
      return session
    },
  }
}
