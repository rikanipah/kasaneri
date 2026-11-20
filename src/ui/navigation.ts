// 界面导航历史（Ctrl+Alt+←/→ 在打开过的卡片之间前后跳，不猜测下一张）。
export interface NavigationHistory {
  record(id: string, currentId: string | null | undefined): void;
  back(openCard: (id: string) => Promise<void>): Promise<boolean>;
  forward(openCard: (id: string) => Promise<void>): Promise<boolean>;
  readonly index: number;
  readonly length: number;
}

export function createNavigationHistory(limit = 200): NavigationHistory {
  const stack: string[] = [];
  let index = -1;
  let restoring = false;

  return {
    record(id, currentId) {
      if (restoring || currentId === id) return;
      stack.splice(index + 1);
      stack.push(id);
      index = stack.length - 1;
      if (stack.length > limit) {
        stack.shift();
        index = stack.length - 1;
      }
    },
    async back(openCard) {
      if (index <= 0) return false;
      restoring = true;
      try {
        index--;
        await openCard(stack[index]!);
        return true;
      } finally {
        restoring = false;
      }
    },
    async forward(openCard) {
      if (index < 0 || index >= stack.length - 1) return false;
      restoring = true;
      try {
        index++;
        await openCard(stack[index]!);
        return true;
      } finally {
        restoring = false;
      }
    },
    get index() { return index; },
    get length() { return stack.length; },
  };
}
