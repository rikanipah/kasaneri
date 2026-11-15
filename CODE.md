# Code and build

## Build from source

Use Node.js 24 and npm.

```sh
npm ci
npm run build
npx tsc --noEmit
```

On Windows, run `npm run package:windows` to build a portable app. On Linux, run `npm run package:linux` on that platform. Build output goes to `dist/` and packaged apps go to `release/`.

## Source layout

| Path | Responsibility |
| --- | --- |
| `src/app/` | Electron windows, IPC, the first-run wizard, backups, snapshots, attachments, and terminal |
| `src/ui/` | Workspace, Directory Tree, Memory Tree, Card Browser, and settings |
| `src/data/` | SQLite, migrations, imports, search, Trash, and the English tutorial for new libraries |
| `src/study/` | FSRS review, the To-do queue, prerequisites, and parameter optimization |
| `src/folders/` | Directory views and deck settings inheritance |
| `src/sync/` | LAN sync, content versions, and conflict resolution |
| `src/core/` | Shared types, rules, and interface translations |
| `src/vendor/` | Adapted Foliole algorithms, icon credits, and third-party licenses |
| `scripts/` | Build and packaging scripts |

The renderer calls the main process through the preload bridge. The main process delegates SQLite work to a database worker. The desktop interface uses a shared translation catalog for Simplified Chinese and English. The interface language is a local preference and stays with the application when its library is changed.

Read the [README](README.md) for product usage and the [MIT license](LICENSE) for redistribution terms.
