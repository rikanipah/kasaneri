import type { Locale } from './i18n';
import type { CardDocuments } from './attachment-document';

export type NodeKind = 'folder' | 'topic' | 'material' | 'cloze';

export interface Anchor {
  quote: string;
  prefix: string;
  suffix: string;
  start?: number;
  section?: 'question' | 'answer';
  highlight?:'extract'|'cloze';
  // Ctrl+点击高亮跳转到对应的卡片，需要知道这条锚点指向哪个节点。
  nodeId?: string;
}

export interface TreeNode {
  id: string;
  parentId: string | null;
  folderId: string | null;
  priority: number | null;
  sourceId: string | null;
  kind: NodeKind;
  title: string;
  position: number;
  hasChildren: boolean;
}

export interface Material extends TreeNode {
  content: string;
  answer: string;
  documents?: CardDocuments;
  anchor: Anchor | null;
  revision: number;
  // getNode 会返回每张卡片的 metadata（nodes.metadata JSON 列）。
  // 目前只存放启动配置：metadata.launch = {command:string; args?:string[]; cwd?:string}。
  // 其他 AI 接手时，新增元数据请沿用这个字段，而不是再开新列。
  metadata?: Record<string, unknown>;
}

export interface NodeInput {
  id: string;
  parentId: string | null;
  sourceId: string | null;
  kind: NodeKind;
  title: string;
  content: string;
  answer: string;
  anchor: Anchor | null;
  position: number;
  metadata?: Record<string, unknown>;
  folderId?:string|null;
  priority?:number|null;
}

export interface DirectoryBranch {
  parentId: string | null;
  items: TreeNode[];
}

export interface ChildrenPage {
  items: TreeNode[];
  cursor: { position: number; id: string } | null;
}

export interface SaveInput {
  id: string;
  revision: number;
  content: string;
  answer: string;
  documents?: CardDocuments;
}

export type CardRelationKind='memory'|'related';
export interface CardRelationKey {
  parentId:string;
  childId:string;
  kind:CardRelationKind;
}
export interface CardRelation extends CardRelationKey {
  title:string;
}
export interface CardRelationCandidate {id:string;path:string}
export interface MemoryTreeLink {id:string;title:string;kind:Exclude<NodeKind,'folder'>}
export interface MemoryTreeCard {
  id:string;
  title:string;
  kind:Exclude<NodeKind,'folder'>;
  onPath:boolean;
  children:string[];
  related:MemoryTreeLink[];
}
export interface MemoryTreeSnapshot {roots:string[];cards:MemoryTreeCard[]}

export type DependencyOverride='require'|'ignore'|null;
export interface PrerequisiteEntry {
  id:string;
  title:string;
  inherited:boolean;
  mode:DependencyOverride;
  mastered:boolean;
  blocked:boolean;
}
export interface PrerequisiteState {blocked:boolean;cards:PrerequisiteEntry[]}
export interface PrerequisiteChange {
  id:string;
  prerequisiteId:string;
  mode:DependencyOverride;
  expected:DependencyOverride;
}

export interface AgainChildSelection {id:string;revision:number}
export interface AgainChildCandidate extends AgainChildSelection {title:string;dueAt:number}

export interface CreateInput {
  parentId: string | null;
  kind: NodeKind;
  title?: string;
  /** 独立「添加卡片」窗口直接写入正文与答案（不经过摘录选区） */
  content?: string;
  answer?: string;
  from?: number;
  to?: number;
  section?: 'question' | 'answer';
  revision?: number;
}

export interface Asset {
  id: string;
  filename: string;
  mime: string;
  size: number;
  relativePath: string;
}

export interface FolderCounts {new:number;learning:number;review:number;readingDue:number;fsrsDue:number}
export interface StudyItem {
  id:string;token:string;kind:'reading'|'fsrs';isTest:boolean;title:string;state:'new'|'learning'|'review';
  priority:number;revision:number;preview:Array<{rating:1|2|3|4;dueAt:number}>;
  pushPreview?:{read:number;later:number};
}
export interface StudySnapshot {
  sessionId:string;folderId:string|null;folderTitle:string;mode:'cards'|'reading';item:StudyItem|null;
  completed:number;canUndo:boolean;nextDueAt:number|null;
  postponed:number;   // 本次进入待办时 auto-postpone 延后的低优先级材料数
  counts:{new:number;learning:number;review:number;readingDue:number};
}
export interface FolderInfo {id:string;title:string;parentId:string|null}
export interface DeckConfiguration {
  folderId:string;title:string;path:string;inheritedFrom:string;
  overrides:Partial<import('./settings').ReviewSettings>|null;
  inherited:import('./settings').ReviewSettings;effective:import('./settings').ReviewSettings;
}

export type EditorSlot='workspace'|'browser';

export interface ReadingBridge {
  request<T = unknown>(action: string, payload?: unknown): Promise<T>;
  /** 本机界面状态（不跟资料库同步），例如关闭前聚焦的卡片。 */
  uiStateGet(key: string): Promise<unknown>;
  uiStateSet(key: string, value: unknown): Promise<void>;
  getLanguage(): Promise<Locale>;
  setLanguage(value: Locale): Promise<void>;
  importFiles(files: File[]): Promise<Asset[]>;
  mediaUrl(id: string): string;
  windowAction(action: 'minimize' | 'maximize' | 'close'): void;
  platform: NodeJS.Platform;
  /** 为某张卡片打开独立编辑窗口 */
  openCardWindow(id: string): Promise<boolean>;
  /** 独立浏览窗口与添加卡片窗口 */
  openBrowserWindow(status?:'conflict',cardId?:string|null): Promise<boolean>;
  openAddCardWindow(folderId:string|null): Promise<boolean>;
  /** 关闭当前独立编辑窗口 */
  closeCardWindow(): void;
  onCloseRequested(callback: () => void): void;
  confirmClose(): void;
  readEditorCard(slot:EditorSlot,id:string):Promise<Material|null>;
  setEditorCard(slot:EditorSlot,id:string|null):void;
  onSyncedContent(callback:(applied:boolean,parentId?:string|null,nodeId?:string|null)=>void):void;
  // 1.6 新增：从卡片启动外部程序/终端。
  // 只有主进程能 spawn；渲染层处于沙盒（sandbox:true），必须走这条受限通道。
  launch(request: LaunchRequest): Promise<LaunchResult>;
  // 内嵌终端（PTY 在主进程，渲染层只持有 xterm 视图）。
  terminalNew(request: TerminalRequest): Promise<{ id: string; pid: number }>;
  terminalInput(id: string, data: string): void;
  terminalResize(id: string, cols: number, rows: number): void;
  terminalKill(id: string): void;
  onTerminalData(callback: (event: { id: string; data: string }) => void): void;
  onTerminalExit(callback: (event: { id: string }) => void): void;
  // 快照导出/导入（同步方案阶段 0）。不传 target/source 时弹目录选择框。
  exportSnapshot(target?: string): Promise<{ ok: boolean; cancelled?: boolean; path?: string }>;
  importSnapshot(source?: string): Promise<{ ok: boolean; cancelled?: boolean }>;
  // 桌面对等同步。
  syncConfigure(config: SyncState['config'] & { passphrase?: string; name?: string }): Promise<SyncState>;
  syncNow(): Promise<SyncState>;
  syncStatus(): Promise<SyncState>;
  syncTestPeer(address:string): Promise<{ok:boolean;message:string}>;
  syncConflicts(): Promise<{ count:number;items:SyncConflictItem[] }>;
  syncResolveConflict(file:string,choice:SyncConflictChoice):Promise<SyncConflictResolution>;
  syncChooseContent(nodeId:string,heads:string[],selected:string):Promise<{status:string;reason?:string}>;
  /** 冲突处理时删除这张卡片（写删除版本，卡片进垃圾桶）。 */
  syncDiscardContent(nodeId:string):Promise<{status:string;reason?:string}>;
  // 自动备份（快照拷到指定文件夹，按间隔自动执行）
  backupStatus(): Promise<BackupState>;
  backupConfigure(config: Partial<BackupConfig>): Promise<BackupState>;
  backupChooseFolder(): Promise<BackupState>;
  backupNow(): Promise<BackupState & { result: { ok: boolean; path?: string; error?: string; pruned?: number } }>;
}

// keepLast = 备份文件夹里最多保留多少份快照（0 = 不自动清理）。
export interface BackupConfig { enabled: boolean; folder: string; intervalHours: number; lastAt: number; keepLast: number }
export interface BackupState { config: BackupConfig; status: { at: number; error: string; path: string; pruned?: number } }

export type SyncConflictChoice='local'|'incoming';
export interface SyncConflictResolution {choice:SyncConflictChoice;at:number;operationId:string}
export type SyncConflictItem=
  |{kind:'schedule';file:string;nodeId:string;at:number;peer:string;detail?:unknown;selectable:boolean;
    resolution?:SyncConflictResolution|null;dispute?:unknown}
  |{kind:'content';nodeId:string;localVersionId:string|null;versions:import('../sync/content-versions').ContentVersion[]};
export interface SyncState {
  /** 本机可连接地址与监听端口 */
  addresses?: Array<{ address: string; kind: string }>;
  port?: number;
  /** 本机设备名（对端按名字区分）；logs 为最近同步记录 */
  deviceName?: string;
  hasPassphrase?: boolean;
  logs?: Array<{ at: number; peer: string; ok: boolean; pulled: number; pushed: number; ms: number; message: string }>;
  status: { at: number; pulled: number; pushed: number; error: string; running?: boolean; lastOk?: number;
    lastCycle?:{pulled:number;pushed:number;ms:number;failed:number};
    logs?: Array<{ at: number; peer: string; ok: boolean; pulled: number; pushed: number; ms: number; message: string }> };
  config: { enabled: boolean; port: number; peers: Array<{ name: string; address: string }> };
  deviceId: string;
}

// 终端创建参数。shell 白名单 cmd/powershell/pwsh/bash，缺省按平台选；
// cwd 缺省为程序数据目录。cols/rows 会被钳制在 20–500 / 5–200。
export interface TerminalRequest {
  cwd?: string;
  cols?: number;
  rows?: number;
  shell?: 'cmd' | 'powershell' | 'pwsh' | 'bash';
}

// 1.6 新增：卡片启动配置。存在 nodes.metadata.launch 里。
// 安全边界：主进程不用 shell:true，command 按可执行文件直接 spawn，杜绝命令注入。
export interface LaunchRequest {
  command: string;      // 可执行文件路径或命令名；'cmd' 表示打开终端窗口
  args?: string[];      // 最多 20 个参数
  cwd?: string;         // 工作目录，缺省为程序数据目录
}
export interface LaunchResult { ok: boolean; pid?: number }

// FSRS 参数优化请求与结果（worker action 'optimizeDeck'）。
// folderId=null 表示用全部牌组的复习历史训练（全局默认参数）。
export interface OptimizeRequest {
  folderId: string | null;
  modelVersion: 'FSRS-6' | 'FSRS-7';
  enableShortTerm: boolean;
  currentWeights: number[] | null;
  evaluate?: boolean;
}
export interface OptimizeResult {
  trainingItemCount:number;
  weights: number[];
  reviewCount: number;
  cardCount: number;
  durationMs: number;
  evaluation: { logLoss: number; rmseBins: number } | null;
  currentEvaluation: { logLoss: number; rmseBins: number } | null;
}

export type CatalogState='new'|'learning'|'review'|'hold'|'buried'|'suspended'|'empty'|'push'|'leech';
export type CatalogStatus=CatalogState|'due'|'conflict';
export interface CatalogQuery {
  query?:string;folderId?:string|null;kind?:'all'|'topic'|'material'|'cloze';
  status?:'all'|CatalogStatus;conflictIds?:string[];
  /** 多选筛选：同一组内 OR，组与组之间 AND；空数组/不传表示不筛选。 */
  kinds?:NodeKind[];statuses?:CatalogStatus[];
  sort?:'created'|'updated'|'title'|'due'|'kind'|'folder'|'state'|'reps';direction?:'asc'|'desc';offset?:number;limit?:number;
  /** 续页加载时不必重算总数——搜正文的 count 要整表扫一遍。 */
  countTotal?:boolean;
}
export interface CatalogRow {
  id:string;title:string;kind:NodeKind;folderId:string|null;folderTitle:string|null;deletedAt:string|null;
  state:CatalogState;dueAt:number|null;reps:number;createdAt:string;updatedAt:string;
  reviewEnabled:boolean;pushEnabled:boolean;reviewReady:boolean;
}
export interface CatalogPage {items:CatalogRow[];total:number;offset:number;limit:number}

declare global {
  interface Window {
    reading: ReadingBridge;
  }
}
