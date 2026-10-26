import type { ConversationTurn } from "../types.js";

/**
 * Tracks conversation history for pipeline mode.
 * Maintains a sliding window of turns within a token budget.
 * In speech-to-speech mode, this acts as a local mirror for logging/display.
 */
export class ConversationContext {
  private turns: ConversationTurn[] = [];
  private maxTurns: number;

  constructor(options: { maxTurns?: number } = {}) {
    this.maxTurns = options.maxTurns ?? 50;
  }

  addTurn(turn: ConversationTurn): void {
    this.turns.push(turn);
    this.prune();
  }

  /** Get all turns for passing to the agent. */
  getHistory(): readonly ConversationTurn[] {
    return this.turns;
  }

  /**
   * Format the conversation history as a preamble for the agent.
   * Includes speaker attribution for multi-user sessions.
   */
  formatForAgent(): string {
    if (this.turns.length === 0) return "";
    return this.turns
      .map((t) => {
        const speaker = t.role === "user"
          ? (t.username ? `User (${t.username})` : "User")
          : "Assistant";
        return `${speaker}: ${t.content}`;
      })
      .join("\n");
  }

  clear(): void {
    this.turns = [];
  }

  get length(): number {
    return this.turns.length;
  }

  private prune(): void {
    while (this.turns.length > this.maxTurns) {
      this.turns.shift();
    }
  }
}
