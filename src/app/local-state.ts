import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 1.200：本机界面状态（和资料库无关）。
 * 存在 <data>/../state/ui-state.json，跟着这台机器走：换资料库、导入快照、同步都不会带走。
 * 目前用来记「关闭前聚焦的卡片」；窗口位置、侧栏宽度等以后也可以放这里。
 */
export class LocalUiState {
  private readonly file: string;
  private values: Record<string, unknown>;

  constructor(private readonly stateDir: string) {
    this.file = join(stateDir, 'ui-state.json');
    this.values = this.load();
  }

  private load(): Record<string, unknown> {
    try {
      const value = JSON.parse(readFileSync(this.file, 'utf8')) as unknown;
      return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }

  get(key: string): unknown {
    return Object.prototype.hasOwnProperty.call(this.values, key) ? this.values[key] : null;
  }

  set(key: string, value: unknown): void {
    this.values[key] = value;
    mkdirSync(this.stateDir, { recursive: true });
    const temporary = this.file + '.tmp';
    writeFileSync(temporary, JSON.stringify(this.values, null, 2), 'utf8');
    renameSync(temporary, this.file);
  }
}
