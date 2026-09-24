interface ProgressOutput {
  isTTY?: boolean;
  columns?: number;
  write(text: string): unknown;
}
export class ProgressLine {
  private visible = false;
  constructor(private readonly output: ProgressOutput = process.stdout) {}
  update(message: string) {
    if (!this.output.isTTY) return;
    // Prevent wrapping: clearing one terminal line must also erase the entire message.
    const width = Math.max(1, (this.output.columns || 80) - 1);
    const line = Array.from(message.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')).slice(0, width).join('');
    this.output.write(`\r\x1b[2K${line}`);
    this.visible = true;
  }
  clear() {
    if (!this.visible) return;
    this.output.write('\r\x1b[2K');
    this.visible = false;
  }
}
