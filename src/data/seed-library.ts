import type {Repository} from './database';

/** Editable English tutorial cards for a new library, in either interface language. */
const TOPICS:Array<{title:string;content:string}>= [
  {
    title:'Incremental Reading',
    content:`Right-click a folder and choose **New topic**, or press Alt+F. A topic can contain extracts, and each extract can have its own children.

Select text and press Alt+A to create an extract. The selection becomes a highlighted anchor. Ctrl-click it to open the extract. If several cards share the anchor, choose one from the list.

Select text and press Alt+S to create a test card. The question starts with the source text and the selected text goes into the answer. You can edit both. Alt+D creates a blank extract under the current card.

The controls at the bottom left toggle extract and test-card highlights. The third control toggles all highlights. You can change keyboard shortcuts under Settings → Shortcuts.`,
  },
  {
    title:'Reviewing Test Cards',
    content:`Each folder in the Directory Tree is a deck. Nested folders are subdecks. Select a folder and click **Review** in the right toolbar, or right-click that folder and choose **Start review**. Only test cards enter review.

FSRS settings are inherited from the nearest parent deck with an override, then from Settings → Default Review. To override settings for a single deck, right-click its folder and choose **Review settings**.

Press Space to reveal the answer. Rate **Again** with 1 or **Good** with 3. Hard and Easy are hidden by default and can be enabled in Default Review.

If consecutive Again ratings reach the configured leech threshold, the default action is to tag the card and pause it to To-do so you can revise it. You can do this manually with **More → Pause to To-do**. When a card needs a decision about whether to keep it, use **More → On hold** and find it later in the Card Browser. A card on hold is outside both queues.`,
  },
  {
    title:'Working Through To-do',
    content:`To-do schedules materials for reading and editing. Open it with the book icon in the right toolbar or with Alt+L.

- **Read** schedules the material again after a longer interval.
- **Later** brings it back sooner so you can continue where you left off.
- **Done** keeps the card in the library and stops scheduling it in To-do.

Adjust the intervals and priorities under Settings → Default To-do.`,
  },
  {
    title:'Directory Tree',
    content:`The Directory Tree shows where folders, topics, extracts, and test cards are stored. Click a row to select it. Use + or − to expand or collapse its children.

Right-click a folder or card for its available actions. Use the colored filters at the top to show topics, extracts, or test cards.`,
  },
  {
    title:'Memory Tree and Prerequisites',
    content:`The Memory Tree shows a card’s parent, children, and related links. For example, **Van ’t Hoff equation** can be a parent and **Meaning of the equilibrium constant** its test child. The parent waits for its test children to meet the prerequisite threshold before entering review.

Right-click a parent and choose **New test child card** to create a prerequisite. Creating a test child from the Directory Tree also adds it to the Memory Tree. Click a child in the Memory Tree to open it in the workspace and locate it in the Directory Tree. The Memory Tree keeps its current branches and scroll position.

Use **Link related card…** to add a shortcut to another card. You can also add or ignore prerequisites in **Card info**.`,
  },
];

/**
 * 全新的资料库自动在默认文件夹里放一份引导，老库不动（只认一次 flag + 空库判断）。
 * 调用方是 worker 打开资料库之后，此时 StudyService 已经就绪、能给新卡建排程。
 */
export function seedDefaultLibrary(repository:Repository,register:(id:string)=>void):boolean{
  if(repository.getSetting('seedLibraryV1'))return false;
  const others=Number(repository.query("SELECT count(*) n FROM nodes WHERE deleted_at IS NULL AND id NOT IN ('folder:unfiled','folder:recovered')").get()!.n);
  if(others)return false;
  const folderId=repository.ensureDefaultFolder();
  repository.transaction(()=>{
    for(const topic of TOPICS){
      const created=repository.create({parentId:folderId,kind:'topic',title:topic.title,content:topic.content});
      // 引导不参与「撤销新建」，免得 Ctrl+Z 一下把说明删了
      repository.query('DELETE FROM creation_undo WHERE node_id=?').run(created.node.id);
      register(created.node.id);
    }
    repository.setSetting('seedLibraryV1',true);
  });
  return true;
}
