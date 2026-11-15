export const SNAPSHOT_PREFIX = 'Kasaneri-快照-';
const snapshotName = /^(?:Kasaneri|Leafloop|IncrementalReading)-快照-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)(?:-[A-Za-z0-9]+)?$/u;

/** 返回应当删除的快照目录名（保留最近 keepLast 份；keepLast<=0 表示不限制）。 */
export function snapshotsToPrune(names: string[], keepLast: number): string[] {
  const keep = Math.floor(Number(keepLast) || 0);
  if (!(keep > 0)) return [];
  const snapshots = names.flatMap(name => {
    const match = snapshotName.exec(name);
    return match ? [{name, timestamp: match[1]}] : [];
  }).sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.name.localeCompare(right.name));
  return snapshots.slice(0, Math.max(0, snapshots.length - keep)).map(snapshot => snapshot.name);
}
