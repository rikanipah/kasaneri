// ===== 从 Windows/任何平台交叉打包 Linux 版 =====
// 用途：在 Windows 开发机上产出 Arch Linux 能直接跑的完整目录 + tar.gz。
// 步骤：① 安装 Linux 原生产物（sharp/@open-spaced-repetition 的 linux 变体，--no-save 不动 package.json）；
//       ② 下载 electron-vX-linux-x64.zip（官方 release，可用 ELECTRON_MIRROR 换镜像）；
//       ③ 组装与 package-linux.mjs 相同布局（resources/app：dist + node_modules 原生依赖 + package.json）；
//       ④ 附 run-linux.sh 与 .desktop，打 tar.gz。
// 产物：release/Kasaneri-Linux/ 与 release/Kasaneri-Linux.tar.gz。
import {cpSync,mkdirSync,writeFileSync,readFileSync,renameSync,chmodSync,existsSync,createWriteStream,rmSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {copyNativeDependencies,pruneForeignPlatforms} from './native-dependencies.mjs';
import {copyLicenses} from './licenses.mjs';
import {copyApplication} from './application-files.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
process.chdir(root);
const version=JSON.parse(readFileSync('node_modules/electron/package.json','utf8')).version;
const cache=resolve('scripts/.cache');mkdirSync(cache,{recursive:true});

// ① Linux 原生产物（Windows 下 npm 只装了 win32 变体）——直接从 registry 下载解压，
// 不跑包管理器，避免 pnpm/npm 混用破坏现有 node_modules 布局。
const lockedPackages=JSON.parse(readFileSync('package-lock.json','utf8')).packages;
async function fetchLinuxPackage(name){
  const target=`node_modules/${name}`;
  const {version,resolved,integrity}=lockedPackages[target];
  const manifest=join(target,'package.json');
  if(existsSync(manifest)&&JSON.parse(readFileSync(manifest,'utf8')).version===version)return;
  const tgz=join(cache,name.replace('/','-')+'-'+version+'.tgz');
  const [algorithm,digest]=integrity.split('-',2);
  const verified=()=>existsSync(tgz)&&createHash(algorithm).update(readFileSync(tgz)).digest('base64')===digest;
  if(!verified()){
    console.log('下载 Linux 原生产物 '+name+'@'+version+' …');
    const response=await fetch(resolved);
    if(!response.ok||!response.body)throw Error('下载失败 HTTP '+response.status);
    await pipeline(Readable.fromWeb(response.body),createWriteStream(tgz));
    if(!verified())throw Error('原生依赖校验失败 '+name+'@'+version);
  }
  mkdirSync(target,{recursive:true});
  execFileSync('tar',['-xzf',tgz,'-C',target,'--strip-components=1'],{stdio:'inherit'});
}
await fetchLinuxPackage('@img/sharp-linux-x64');
await fetchLinuxPackage('@img/sharp-libvips-linux-x64');
await fetchLinuxPackage('@open-spaced-repetition/binding-linux-x64-gnu');

// ② Electron Linux 发行包
const mirror=process.env.ELECTRON_MIRROR||'https://github.com/electron/electron/releases/download';
const url=`${mirror}/v${version}/electron-v${version}-linux-x64.zip`;
const zip=join(cache,`electron-v${version}-linux-x64.zip`);
if(!existsSync(zip)){
  console.log('下载 '+url+' …');
  const response=await fetch(url);
  if(!response.ok||!response.body)throw Error('下载失败 HTTP '+response.status);
  await pipeline(Readable.fromWeb(response.body),createWriteStream(zip));
}
const unpack=join(cache,`electron-v${version}-linux-x64`);
if(!existsSync(join(unpack,'electron'))){
  rmSync(unpack,{recursive:true,force:true});mkdirSync(unpack,{recursive:true});
  execFileSync('tar',['-xf',zip,'-C',unpack],{stdio:'inherit'});
}

// ③ 组装
const output=resolve('release/Kasaneri-Linux');rmSync(output,{recursive:true,force:true});mkdirSync(output,{recursive:true});
cpSync(unpack,output,{recursive:true});
const app=join(output,'resources/app');copyApplication(app);
copyNativeDependencies(app);
pruneForeignPlatforms(app,'linux');
copyLicenses(join(output,'licenses'));
renameSync(join(output,'electron'),join(output,'Kasaneri'));chmodSync(join(output,'Kasaneri'),0o755);

// ④ Wayland/niri 启动脚本 + .desktop（数据目录在 XDG_DATA_HOME 或 ~/.local/share/kasaneri）
writeFileSync(join(output,'run-linux.sh'),`#!/bin/sh
# 启动脚本。有 Wayland 会话就直接用 Wayland（niri/sway/Hyprland 下 hint=auto 会退回 X11）；
# 没有 Wayland 时退回 --ozone-platform-hint=auto（X11/XWayland 环境）。
cd "$(dirname "$0")" || exit 1
# Windows 交叉打包时可能丢失 Electron 可执行文件的 Unix 权限。
for executable in Kasaneri chrome_crashpad_handler chrome-sandbox; do
  [ -x "./$executable" ] || chmod u+x "./$executable" || exit 1
done
if [ -n "\${WAYLAND_DISPLAY:-}" ]; then
  exec ./Kasaneri --ozone-platform=wayland --enable-wayland-ime "$@"
else
  exec ./Kasaneri --ozone-platform-hint=auto "$@"
fi
`);
chmodSync(join(output,'run-linux.sh'),0o755);
writeFileSync(join(output,'kasaneri.desktop'),`[Desktop Entry]
Type=Application
Name=Kasaneri
Comment=incremental reading: material to extracts to cards, FSRS review
Exec=PLACEHOLDER
Terminal=false
Categories=Education;Utility;
StartupWMClass=Kasaneri
`);
writeFileSync(join(output,'install-desktop-entry.sh'),`#!/bin/sh
# 一键把启动项装到当前用户（自动写入解压后的真实绝对路径）
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET="$HOME/.local/share/applications/kasaneri.desktop"
mkdir -p "$HOME/.local/share/applications"
sed "s#PLACEHOLDER#$DIR/run-linux.sh#" "$DIR/kasaneri.desktop" > "$TARGET"
chmod +x "$DIR/run-linux.sh"
update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
echo "已安装启动项: $TARGET"
echo "在启动器里搜索 Kasaneri"
`);
chmodSync(join(output,'install-desktop-entry.sh'),0o755);
writeFileSync(join(output,'安装说明-Linux.md'),`# Linux 版使用说明（Arch Linux / Wayland / niri）

1. 解压 tar.gz 到任意目录（建议 ~/Applications 或 ~/.local/opt）。
2. 终端运行 ./run-linux.sh（已带 --ozone-platform-hint=auto，适配纯 Wayland 的 niri）。
   或直接执行 ./Kasaneri。
3. 首次启动会创建数据目录：$XDG_DATA_HOME/kasaneri
   （未设置 XDG 时为 ~/.local/share/kasaneri），布局如下：
     library/         资料库（library.sqlite + assets + cache）
     trash/           删除快照（Markdown）
     backups/         快照备份（默认每天一次，可在 设置 → 备份 里改）
   本机状态位于相邻的 state/（窗口缓存及设备标识）。
4. 把快照（另一台机器导出的 Kasaneri-快照-* 文件夹）拷过来，
   在 设置 → 常规 → 数据 → 导入快照 恢复卡片库。
5. 多端同步：设置 → 同步。两端填同一口令，互相添加对方「地址:端口」
   （本机 IP 用 ip addr 查，例如 192.168.1.10:38641）。局域网内即可收敛；
   跨网段时两端装 Tailscale 后同样适用。注意：两端时间差超过 2 分钟会拒绝同步，
   请确认系统时间已同步（systemd-timesyncd / chrony）。
6. .desktop 文件可放到 ~/.local/share/applications/ 加入启动器（Exec/Path 改成实际路径）。
7. 若提示缺少库，Arch 上执行：sudo pacman -S --needed gtk3 nss libx11 libxcomposite libxdamage
   libxrandr libxkbcommon libdrm mesa alsa-lib；Wayland 下如出现空白窗口，先试
   LIBGL_ALWAYS_SOFTWARE=1 ./run-linux.sh。
8. 本版本为新数据布局（data 只放 library/trash/backups，窗口缓存移到 state/），
   旧的 data/window-profile 会在首次启动时自动迁移，不需要手动处理。
`);
console.log('Linux program: '+join(output,'Kasaneri'));
execFileSync('tar',['-czf','release/Kasaneri-Linux.tar.gz','-C','release','Kasaneri-Linux'],{stdio:'inherit'});
console.log('归档: release/Kasaneri-Linux.tar.gz');
