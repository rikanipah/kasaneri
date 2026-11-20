### English | [简体中文](README.zh-CN.md)

---

# Kasaneri

# Note

> **Most of this project was written by vibe coding with models such as ChatGPT and DeepSeek. It is an experimental attempt at some of my own ideas.**
>
> The needs this app serves are **highly personal**, and it still needs testing and refining through my own long-term use. An installer exists, but only as a reference for how the ideas could be implemented; **other users' experience was not considered**!! The Assets in each Release are the builds I was using at the time.
>
> This project is published **only** to provide a reference for ideas and implementations, and to keep a record. That means the app has not been used for very long, and **it is all BUGS**!!

## What is this

Kasaneri is a learning tool based on theories such as the [FSRS memory algorithm](https://github.com/open-spaced-repetition/free-spaced-repetition-scheduler) and [incremental reading](https://www.masterhowtolearn.com/2018-10-28-why-i-switched-to-supermemo/), borrowing features from projects such as [SuperMemo](https://supermemo.com) and [Anki](https://apps.ankiweb.net).

Kasaneri keeps review and pushing separate: you create topic cards, and the To-do mechanism keeps pushing the material you need to learn, where you make extract cards, keep revising them, and distill knowledge points into test cards. Once a test card is created it enters the review mechanism and is scheduled by FSRS. You can review test cards right away, or send a test card back to the pushing mechanism to revise it, until you have mastered the material.

Kasaneri's editing interface is based on Electron and is clean and simple.

See [CODE.md](CODE.md) for the code structure. This project uses the MIT license; the full text is in [LICENSE](LICENSE) at the repository root.

## Why I made this

1. In Anki, after a card is suspended, there is often no motivation to come back to it. Suspended cards pile up, the bigger the pile the less you want to touch it, and it turns into a vicious cycle. I wanted a push mechanism like SuperMemo's, so some memory cards keep being pushed back for revision and improvement.

2. With incremental reading in mind, some cards can only be understood after their logical prerequisites are grasped. For example (card A) the Van 't Hoff isobar equation

   $\displaystyle \left( \dfrac{\partial \ln K^\ominus(T)}{\partial T} \right)_p = \dfrac{\Delta_r H^\ominus}{RT^2}$

   requires understanding what $K^{\ominus}(T),\ R,\ \Delta_{r}H^{\ominus}$ mean in chemistry (the nearby fields A1, A2, A3), and also understanding what a differential means in mathematics (the more distant field B1). If the knowledge in the sense of logical prerequisites has not been mastered, you can still copy the formula by rote, but efficiency is not high either.

3. I like using Obsidian, am used to editing material in Markdown, and Electron makes personalization easy.

4. Why not write a plug-in for Anki or Obsidian: a plug-in is limited by the software itself, many features would need major changes, and the underlying layers differ. AI agents can already handle most of the manual work now, so apart from losing both money and time there is not much cost.

5. I was free, it seemed interesting, and I wanted to learn the related process and knowledge by trying.

## Core features

### Review

Scheduling uses [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs) (FSRS-6 / FSRS-7 selectable), and parameter optimization calls the official [@open-spaced-repetition/binding](https://github.com/open-spaced-repetition/ts-fsrs/tree/main/packages/binding).

Mostly following Anki, but with a few features that differ.

#### Suspend is split into Pause to To-do and On hold

Anki's "suspend" is changed into two parts with different meanings:

- **Pause to To-do**: the test card leaves review and enters To-do, where the To-do algorithm pushes it repeatedly so the test card can be edited and improved. Once it is handled in To-do, clicking "Return to review" cancels the pause and puts it back into review; at that point the test card's previous ratings are cleared and it is pushed as a "new card", but the card's own operation history (To-do and review rating records) is kept.
- **On hold**: marks the test card as on hold. Such a card is not pushed by To-do or review, but you can browse it in the Card Browser and decide for yourself whether to keep or delete it. Works together with To-do.

#### Prerequisite cards

At the memory level, cards with a parent/child relation are prerequisite cards. You can set prerequisite child cards: a memory parent card can only be unlocked after the prerequisite cards set beforehand are mastered; if the child cards are not mastered, the parent card does not enter the review queue. The unlock condition is the child card "Good N times in a row", N defaulting to 4, changeable in review settings. Because the sample size is insufficient, I do not plan to explore the optimal prerequisite algorithm for now. For why this feature was introduced, see the second point of "Why I made this".

#### Leeches can loop

When a card's consecutive Again ratings reach the threshold (4 by default), it automatically becomes Pause to To-do and is tagged with the leech attribute.

When you click "Return to review" in To-do, the card's memory state is cleared entirely and it is scored again as a new card (stability, difficulty, count, and due date are all reset), while the review records and the leech attribute are kept. The next round starts from 4 again, looping repeatedly. Undoing this "Return to review" restores the state as well.

The leech attribute is followed by the accumulated Again count, for example leech(6), so you can see at a glance how many loops it has been through (undone ratings do not count). It is normally removed manually, and undoing the rating that triggered it also restores it.

#### Priority

Because test cards are combined with the To-do feature, they have a SuperMemo-like priority. It does not take part in FSRS memory calculation; it only affects the push interval when the card is a To-do object.

### To-do

Following SuperMemo's incremental reading.

The To-do algorithm currently follows Foliole's algorithm, but the push mechanism is changed.

When material is pushed:

| Action | Follow-up arrangement |
| --- | --- |
| **Read** | If the reading pushed this time is finished, clicking Read pushes it again after a delay. |
| **Later** | If the reading pushed this round is not fully finished, clicking Later pushes it again within a shorter interval than the reading time. |
| **Done** | If the pushed card is completely finished, clicking Done stops the card from being pushed again. |
| **Move to end** | The card is not wanted for now but needs to be handled soon, so it is placed at the end of this round's push queue. |

Through the review feature, leech cards or memory cards that need changes can be brought into To-do continuously via Pause to To-do, making repeated revision and organizing easy.

Newly learned material can also be read incrementally through To-do, continuously revised, and turned into topic cards, extract cards, and test cards.

## Directory Tree and Memory Tree

### Directory Tree

A tree for viewing the hierarchy of cards.

Under folders go topics, extracts, and test cards, nested arbitrarily. At the top there are three buttons in different colors following the colors of topics, extracts, and test cards, which filter by type so only certain types of cards are visible.

### Memory Tree

A tree for viewing prerequisite cards and related cards.

In the lower right area, it shows the current card's parent cards, child cards, and related cards. The parent/child relation is the prerequisite relation; related cards are jump links you set up yourself, purely for quick navigation.

## Installation

Download the Windows installer or the Linux x64 archive from [GitHub Releases](https://github.com/rikanipah/Kasaneri/releases). The same page provides SHA-256 checksum files.

### Windows

1. Download the `Kasaneri-Setup-<version>.exe` installer.
2. Double-click to install and follow the wizard. It installs per user, by default to `%LOCALAPPDATA%\Programs\Kasaneri`, and does not require administrator rights.
3. The program is not code signed, so Windows may show "Windows protected your PC"; click "More info → Run anyway".
4. On first launch it asks you to choose a library folder: you can create a new empty folder, or open an existing library, whose settings will be reused.
5. A library is an ordinary folder (`library.sqlite`, `assets`, `cache`) and can be placed anywhere; upgrading the program and uninstalling do not touch it, deleting it must be done by yourself.
6. To uninstall: Settings → Apps → Kasaneri → Uninstall, or use the uninstall entry in the Start menu.
7. The license shown in the installer is MIT.

If Kasaneri is already installed, exit the app first, then run the new installer and keep the original installation directory. Overwriting the installation keeps your library and settings.

### Linux x64

Download the Linux archive from Releases, choosing the latest version. For example, with v0.5.1, extract and start it like this:

```bash
tar -xzf Kasaneri-Linux-x64-0.5.1.tar.gz
cd Kasaneri-Linux
./run-linux.sh
```

## Other

### Help

Help (**organized by AI for now**) and a guided tutorial (**to be improved**) are built into Settings and can be consulted at any time.

### Editing

The editor uses CodeMirror 6 with Markdown rendering and KaTeX for formulas. Extracts and clozes leave colored anchors in the source text; hold Ctrl and click an anchor to jump back. Images can be pasted or dragged in, and their display width is saved per card. Image occlusion draws boxes on an image, and each box generates a test card.

### Data and backups

The data is a SQLite database, not Anki's library format; compatibility with Anki data still needs work. A library is just a folder: library.sqlite, assets (attachments deduplicated by content sha256), cache (rebuildable image previews). Automatic snapshots keep the latest 14 by default, and an online snapshot can be taken without exiting the program. Deletions are all soft deletions and go to the trash; before permanent deletion a Markdown copy is written.

### Attachments

Attachments are inserted into the body as objects, and the file copy is kept in the library. Settings → Files has attachment management, which can move unreferenced attachments into the attachment recycle bin, and restore or permanently delete them.

### Sync

Sync is a direct LAN connection between two machines on HTTP 38641, with the peer IP entered by hand and requests signed and timestamped. Schedules converge through review_log / reading_log, body text goes by version, and when both sides changed a file it is marked "conflict file", which you resolve card by card in the Card Browser.
