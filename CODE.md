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
| `src/app/` | Electron windows, IPC dispatch, the first-run wizard, backups, snapshots, attachments, and terminal |
| `src/ui/` | Workspace, Directory Tree, Memory Tree, Card Browser, settings, and the editor |
| `src/data/` | SQLite access, migrations, imports, Trash, the action name list, and the onboarding content for new libraries |
| `src/data/onboarding/` | Onboarding cards for new libraries, one Markdown file per language and topic |
| `src/study/` | FSRS review, the To-do queue, prerequisites, and parameter optimization |
| `src/reading/` | To-do push intervals, the four reading actions, and the reading position |
| `src/catalog/` | Query parsing, filters, sorting, and paging for the Card Browser |
| `src/content/` | Anchors, document objects, and attachment references |
| `src/settings/` | Setting defaults, validation, keyboard shortcuts, and cross-device setting sync |
| `src/folders/` | Directory views and deck settings inheritance |
| `src/sync/` | LAN sync, content versions, attachment transfer, and conflict resolution |
| `src/core/` | Shared types, rules, and interface translations |
| `src/types/` | Type declarations for assets imported by the bundler |
| `src/vendor/` | Adapted reading-queue algorithms, icon credits, and third-party licenses |
| `scripts/` | Build and packaging scripts |
| `packaging/` | Windows installer definition and its translations |

The renderer calls the main process through the preload bridge. The main process delegates SQLite work to a database worker and keeps the list of allowed actions in `src/data/action-names.ts`. Review scheduling lives in `src/study/` and is split into queue building, grading, quotas, statistics, and undo. The desktop interface uses a shared translation catalog for Simplified Chinese and English; the interface language is a local preference and stays with the application when its library is changed.

New libraries open with a short onboarding set. Its text is kept in `src/data/onboarding/` as Markdown, one file per topic for each language, and is bundled into the application at build time.

Read the [README](README.md) for product usage and the [MIT license](LICENSE) for redistribution terms.
