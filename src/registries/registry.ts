/** Generic, type-keyed registry used for conditions, triggers and actions. */
export class Registry<H extends { type: string }> {
  private readonly handlers = new Map<string, H>();

  constructor(private readonly kind: string) {}

  register(handler: H): this {
    if (this.handlers.has(handler.type)) {
      throw new Error(`${this.kind} "${handler.type}" is already registered`);
    }
    this.handlers.set(handler.type, handler);
    return this;
  }

  get(type: string): H | undefined {
    return this.handlers.get(type);
  }

  has(type: string): boolean {
    return this.handlers.has(type);
  }

  list(): H[] {
    return [...this.handlers.values()];
  }

  types(): string[] {
    return [...this.handlers.keys()];
  }
}
