import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readFile, readdir, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const manifestName = 'SHA256SUMS.txt';

async function listFiles(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const relativePath = prefix + entry.name;
    if (relativePath === manifestName) continue;
    if (entry.isDirectory()) {
      files.push(...await listFiles(join(directory, entry.name), relativePath + '/'));
    } else if (entry.isFile()) {
      files.push(relativePath);
    } else {
      throw Error(`发布包中包含无法校验的文件类型：${relativePath}`);
    }
  }
  return files;
}

async function fileHash(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function writeWindowsChecksums(directory) {
  const entries = [];
  for (const relativePath of (await listFiles(directory)).sort()) {
    entries.push(`${await fileHash(join(directory, relativePath))}  ${relativePath}`);
  }
  await writeFile(join(directory, manifestName), entries.join('\n') + '\n', 'utf8');
}

async function verifyWindowsChecksums(directory) {
  const manifest = await readFile(join(directory, manifestName), 'utf8');
  const expected = new Map();
  for (const line of manifest.trimEnd().split(/\r?\n/u)) {
    const entry = /^([0-9a-f]{64})  (.+)$/u.exec(line);
    if (!entry || expected.has(entry[2])) throw Error('校验清单格式错误');
    expected.set(entry[2], entry[1]);
  }
  if (!expected.has('Kasaneri.exe')) throw Error('校验清单缺少主程序');
  const files = await listFiles(directory);
  for (const relativePath of files) {
    if (!expected.has(relativePath)) throw Error(`发布包有额外文件：${relativePath}`);
    if (await fileHash(join(directory, relativePath)) !== expected.get(relativePath)) {
      throw Error(`校验不符：${relativePath}`);
    }
    expected.delete(relativePath);
  }
  if (expected.size) throw Error(`发布包缺少文件：${expected.keys().next().value}`);
  return files.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (!process.argv[2]) throw Error('用法：node scripts/windows-checksums.mjs "发布包目录"');
    const count = await verifyWindowsChecksums(resolve(process.argv[2]));
    console.log(`SHA-256 校验通过，共 ${count} 个文件。`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
