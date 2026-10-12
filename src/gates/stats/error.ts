/** Shared error for malformed statistics inputs. All stats helpers fail closed by throwing this. */
export class PairedDifferenceError extends Error {
  constructor(message: string) { super(message); this.name = 'PairedDifferenceError'; }
}
