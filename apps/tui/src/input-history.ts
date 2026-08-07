const MAX_HISTORY = 200;

export class InputHistory {
  private entries: string[] = [];
  private browseIndex = -1;
  private draft = "";

  push(text: string): void {
    const trimmed = text.trim();
    if (!trimmed || trimmed.startsWith("/")) return;
    if (this.entries[this.entries.length - 1] === trimmed) return;
    this.entries.push(trimmed);
    if (this.entries.length > MAX_HISTORY) this.entries.shift();
    this.resetBrowse();
  }

  move(delta: -1 | 1): string | null {
    if (this.entries.length === 0) return null;
    if (this.browseIndex === -1) {
      this.draft = "";
      this.browseIndex = this.entries.length;
    }
    const next = this.browseIndex + delta;
    if (next < 0 || next > this.entries.length) return null;
    this.browseIndex = next;
    if (this.browseIndex === this.entries.length) return this.draft;
    return this.entries[this.browseIndex] ?? null;
  }

  isBrowsing(): boolean {
    return this.browseIndex !== -1;
  }

  resetBrowse(): void {
    this.browseIndex = -1;
    this.draft = "";
  }

  setDraft(text: string): void {
    if (this.browseIndex === -1) this.draft = text;
  }
}
