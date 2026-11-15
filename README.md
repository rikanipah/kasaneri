# Kasaneri

[简体中文](README.zh-CN.md) · [Code and build instructions](CODE.md)

> **Kasaneri is a personal experiment. I wrote much of it through vibe coding with models including ChatGPT and DeepSeek.**
>
> The application is shaped by my own workflow and is still being tested. There is a Windows installer, and the workflow takes some getting used to.
>
> I am publishing it to document the experiment and share ideas and implementations that others can refer to.

## What is Kasaneri?

Kasaneri is a learning tool built around [FSRS](https://github.com/open-spaced-repetition/free-spaced-repetition-scheduler) and [incremental reading](https://www.masterhowtolearn.com/2018-10-28-why-i-switched-to-supermemo/). It draws on features from [SuperMemo](https://supermemo.com) and [Anki](https://apps.ankiweb.net).

Review and To-do have separate schedules. To-do brings back topics so you can read them, make extracts, and turn ideas into test cards. FSRS schedules the test cards for review. You can send a card back to To-do to revise it and return it to review when it is ready. The Electron workspace supports Markdown editing.

## Why I made it

1. Suspended cards in Anki often pile up. I wanted a SuperMemo-style queue that brings those cards back for me to revise.
2. Some cards make sense only after you understand their prerequisites. For example, the Van ’t Hoff equation needs both chemistry and calculus.

   $$
   \left( \dfrac{\partial \ln K^\ominus(T)}{\partial T} \right)_p = \dfrac{\Delta_r H^\ominus}{RT^2}
   $$

   You need to understand the chemical meaning of $K^{\ominus}(T)$, $R$, and $\Delta_r H^{\ominus}$, as well as what a derivative means. Memorizing the formula without that background is less effective.
3. I like the Markdown workflow in Obsidian. Electron also makes the workspace easy to customize.
4. An Anki or Obsidian plug-in would inherit the host application’s limits, and several of these features need changes at a deeper level. Coding agents made a standalone experiment practical for me.
5. I wanted to learn by building it.

## Install on Windows

1. Download **Kasaneri-Setup-1.0.0.exe** from [Releases](https://github.com/rikanipah/Kasaneri/releases).
2. Open the installer and choose **简体中文** or **English**. Simplified Chinese is preselected. The per-user installation defaults to %LOCALAPPDATA%\Programs\Kasaneri and requires no administrator access.
3. On first launch, choose an empty folder for a new library or select an existing Kasaneri library. A new library has five English tutorial cards in its default folder.
4. To change the interface language, go to **Settings → General → Interface language** (设置 → 常规 → 界面语言). Choose a language and reopen Kasaneri.

The installer is unsigned. Windows may show a SmartScreen prompt. To uninstall, open **Settings → Apps** in Windows and select Kasaneri. The MIT license is shown during setup.

## Review

Kasaneri uses [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs) with FSRS-6 and FSRS-7. Parameter optimization uses [@open-spaced-repetition/binding](https://github.com/open-spaced-repetition/ts-fsrs/tree/main/packages/binding).

- **Pause to To-do** takes a test card out of review and schedules it for editing in To-do. **Return to review** starts its FSRS schedule over and keeps the review and reading history.
- **On hold** takes a card out of both queues. Find the card in the Card Browser to decide whether to keep or delete it.
- **Leeches** are flagged after consecutive Again ratings reach the threshold, which is four by default. The default action pauses the card to To-do. When you return it to review, the leech tag and history are preserved, and the next cycle starts from zero. A tag such as leech(6) shows the accumulated lapse count, excluding undone ratings.
- **Priority** runs from 0 through 9 and can be inherited from the folder. It controls To-do intervals. FSRS uses its own review schedule.
- **Prerequisites** are represented by a parent and its test children. The parent becomes eligible for review once its prerequisite children each have the required streak of Good or Easy ratings. The default is four, adjustable in review settings.

## To-do

The queue takes inspiration from SuperMemo’s incremental reading and uses scheduling algorithms adapted from Foliole. You can edit the body, make extracts, and create child cards while reading.

| Action | What happens next |
| --- | --- |
| **Read** | The material returns after a longer interval. |
| **Later** | It returns sooner so you can continue reading. |
| **Done** | It leaves the queue and stays in the library. |

## Directory Tree and Memory Tree

The **Directory Tree** shows folders and the cards they contain. Topics, extracts, and test cards can be nested. The colored controls at the top filter by type.

The **Memory Tree** shows parent cards, child cards, and related links. For example, right-click **Van ’t Hoff equation** and choose **New test child card** to add **Meaning of the equilibrium constant** as a prerequisite. Selecting that child opens it in the workspace and locates it in the Directory Tree. The Memory Tree keeps its expanded branches and scroll position. Creating a child in the Directory Tree also adds it to the Memory Tree. Related links are for navigation.

## Editing, data, and sync

- **Editing.** The workspace uses CodeMirror 6 for Markdown and KaTeX for math. Ctrl-click an anchor in the source text to open the associated card. Paste or drag in images and resize them per card. Image occlusion creates one test card per marked region.
- **Library and backups.** A library is a folder with library.sqlite, assets, and cache. SQLite uses WAL mode. Attachments are deduplicated by SHA-256 and the image cache can be rebuilt. Automatic snapshots keep the latest 14 by default. Online snapshots are available while the app runs. Deleted cards go to Trash, and permanent deletion saves a Markdown copy first.
- **Attachments.** The editor uses asset references for embedded files. Attachment Manager can move unreferenced files to its bin, restore them, or delete them permanently.
- **Desktop sync.** Two devices connect directly over the LAN. The default HTTP port is 38641. Add the peer’s address in Settings. Requests are signed and timestamped. Review and reading logs merge schedules, while card content uses versions. Use the Card Browser to resolve conflicting versions.

For source layout and builds, see [CODE.md](CODE.md). Kasaneri is distributed under the [MIT license](LICENSE).
