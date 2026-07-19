// TUI Notes — CodeMirror 6 editor bundle
// Built with esbuild → js/cm.bundle.js

import { EditorState } from "@codemirror/state";
import {
  EditorView,
  keymap,
  drawSelection,
  highlightActiveLine,
  Decoration,
  ViewPlugin,
  WidgetType,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
} from "@codemirror/commands";
import {
  markdown,
  markdownLanguage,
  markdownKeymap,
} from "@codemirror/lang-markdown";
import {
  syntaxTree,
  HighlightStyle,
  syntaxHighlighting,
  bracketMatching,
  indentOnInput,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { autocompletion } from "@codemirror/autocomplete";

// ---------- formatting helpers ----------

function wrapSelection(view, before, after) {
  const changes = [];
  for (const range of view.state.selection.ranges) {
    if (range.empty) {
      const ins = before + after;
      changes.push({ from: range.from, insert: ins });
    } else {
      const text = view.state.sliceDoc(range.from, range.to);
      const isWrapped =
        view.state.sliceDoc(range.from - before.length, range.from) ===
          before &&
        view.state.sliceDoc(range.to, range.to + after.length) === after;
      if (isWrapped) {
        changes.push(
          { from: range.from - before.length, to: range.from, insert: "" },
          { from: range.to, to: range.to + after.length, insert: "" }
        );
      } else {
        changes.push(
          { from: range.from, insert: before },
          { from: range.to, insert: after }
        );
      }
    }
  }
  view.dispatch(view.state.replaceSelection(...changes));
}

function toggleLine(view, prefix) {
  const { state } = view;
  const { from } = state.selection.main;
  const line = state.doc.lineAt(from);
  const text = line.text;
  const newText = text.startsWith(prefix)
    ? text.slice(prefix.length)
    : prefix + text;
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: newText },
  });
}

const fmtKeymap = keymap.of([
  { key: "Mod-b", run: () => { const v = document.querySelector(".cm-content")?.cmView; if (v) wrapSelection(v, "**", "**"); return true; } },
  { key: "Mod-i", run: () => { const v = document.querySelector(".cm-content")?.cmView; if (v) wrapSelection(v, "*", "*"); return true; } },
  { key: "Mod-k", run: () => { const v = document.querySelector(".cm-content")?.cmView; if (v) wrapSelection(v, "[", "](url)"); return true; } },
  { key: "Mod-`", run: () => { const v = document.querySelector(".cm-content")?.cmView; if (v) wrapSelection(v, "`", "`"); return true; } },
  { key: "Mod-]", run: () => { const v = document.querySelector(".cm-content")?.cmView; if (v) toggleLine(v, "  "); return true; } },
  { key: "Mod-[", run: () => { const v = document.querySelector(".cm-content")?.cmView; if (v) toggleLine(v, "  "); return true; } },
]);

// ---------- list continuation (smart Enter) ----------

function continueList({ state, dispatch }) {
  if (state.selection.ranges.length !== 1) return false;
  const { from } = state.selection.main;
  if (from <= 0) return false;
  const line = state.doc.lineAt(from);
  const text = line.text;

  // Empty quote line — exit blockquote on Enter
  if (/^\s*>+\s*$/.test(text)) {
    dispatch(
      state.update({
        changes: { from: line.from, to: line.to, insert: "\n" },
        selection: { anchor: line.from + 1 }
      })
    );
    return true; // handled
  }

  // Empty checkbox — remove it
  if (/^[\s]*[-*+]\s+\[(?: |x)\]\s*$/.test(text)) {
    dispatch(
      state.update({
        changes: { from: line.from, to: line.to, insert: "" },
        selection: { anchor: line.from }
      })
    );
    return true;
  }

  // Checkbox items with content
  let m = /^(\s*)([-+*]\s+\[(?: |x)\]\s+).+/.exec(text);
  if (m) {
    const insert = `\n${m[1]}${m[2].replace(/\[x\]/, '[ ]')}`;
    dispatch(
      state.update({
        changes: { from, insert },
        selection: { anchor: from + insert.length },
      })
    );
    return true;
  }

  // Empty list item — dedent
  if (/^[\s]*[-*+]\s*$/.test(text) || /^[\s]*\d+\. ?$/.test(text)) {
    dispatch(
      state.update({
        changes: { from: line.from, to: line.to, insert: "" },
        selection: { anchor: line.from }
      })
    );
    return true;
  }

  // Unordered list bullets with content
  m = /^(\s*)([-+*]\s+).+/.exec(text);
  if (m) {
    const insert = `\n${m[1]}${m[2]}`;
    dispatch(
      state.update({
        changes: { from, insert },
        selection: { anchor: from + insert.length },
      })
    );
    return true;
  }

  // Ordered list — auto-increment
  m = /^(\s*)(\d+)\.\s+.+/.exec(text);
  if (m) {
    const next = parseInt(m[2], 10) + 1;
    const insert = `\n${m[1]}${next}. `;
    dispatch(
      state.update({
        changes: { from, insert },
        selection: { anchor: from + insert.length },
      })
    );
    return true;
  }

  // Blockquote continuation (only if it has content)
  m = /^(\s*>+\s*).+/.exec(text);
  if (m) {
    const insert = `\n${m[1]}`;
    dispatch(
      state.update({
        changes: { from, insert },
        selection: { anchor: from + insert.length }
      })
    );
    return true;
  }

  return false; // let default Enter happen
}

const smartEnter = keymap.of([{ key: "Enter", run: continueList }]);

// ---------- hide raw markdown marks when not selected ----------

const hiddenMark = Decoration.mark({ class: "cm-tui-hidden" });
const headingMark = Decoration.mark({ class: "cm-tui-heading" });
const strongMark = Decoration.mark({ class: "cm-tui-strong" });
const emphasisMark = Decoration.mark({ class: "cm-tui-emphasis" });
const quoteMark = Decoration.mark({ class: "cm-tui-quote" });
const codeMark = Decoration.mark({ class: "cm-tui-code" });

// Hides "# ", "**", "*" etc when cursor is elsewhere
function hideMarks(view) {
  const ranges = [];
  const sel = view.state.selection.main;
  for (let { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter(node) {
        const t = node.type.name;
        if (
          t === "HeaderMark" ||
          t === "EmphasisMark" ||
          t === "CodeMark" ||
          t === "QuoteMark"
        ) {
          if (sel.from <= node.to && sel.to >= node.from) return;
          ranges.push(hiddenMark.range(node.from, node.to));
        }
        if (t === "ATXHeading1" || t === "ATXHeading2" || t === "ATXHeading3") {
          ranges.push(headingMark.range(node.from, node.to));
        }
        if (t === "StrongEmphasis") {
          ranges.push(strongMark.range(node.from, node.to));
        }
        if (t === "Emphasis") {
          ranges.push(emphasisMark.range(node.from, node.to));
        }
        if (t === "Blockquote") {
          ranges.push(quoteMark.range(node.from, node.to));
        }
        if (t === "InlineCode") {
          ranges.push(codeMark.range(node.from, node.to));
        }
      },
    });
  }
  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  return Decoration.set(ranges);
}

const markdownStyling = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = hideMarks(view);
    }
    update(u) {
      this.decorations = hideMarks(u.view);
    }
  },
  { decorations: (v) => v.decorations }
);

// ---------- Wiki-links [[Note Name]] ----------

const wikiLinkMark = Decoration.mark({
  class: "cm-tui-wikilink",
  attributes: { title: "Click to open" },
});

function wikiLinkDeco(view) {
  const ranges = [];
  const re = /\[\[([^\]]+)\]\]/g;
  const doc = view.state.doc;
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    let m;
    while ((m = re.exec(line.text)) !== null) {
      const from = line.from + m.index;
      const to = from + m[0].length;
      const sel = view.state.selection.main;
      // Don't hide link while cursor is inside it
      if (sel.from <= to && sel.to >= from) continue;
      ranges.push(wikiLinkMark.range(from, to));
    }
  }
  return Decoration.set(ranges);
}

const wikiLinkPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) { this.decorations = wikiLinkDeco(view); }
    update(u) { this.decorations = wikiLinkDeco(u.view); }
  },
  { decorations: (v) => v.decorations }
);

// ---------- Checkbox widgets ----------

class CheckboxWidget extends WidgetType {
  constructor(checked) {
    super();
    this.checked = checked;
  }
  eq(other) { return other.checked === this.checked; }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-tui-checkbox" + (this.checked ? " checked" : "");
    span.textContent = this.checked ? "[■]" : "[ ]";
    span.style.cursor = "pointer";

    const toggle = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const view = span.closest(".cm-editor")?.cmView;
      if (!view) return;
      try {
        const pos = view.posAtDOM(span);
        const line = view.state.doc.lineAt(pos);
        const newText = line.text.replace(/^(\s*[-*+]\s+\[)( |x)(\])/, (match, p1, p2, p3) => {
          return p1 + (p2 === "x" ? " " : "x") + p3;
        });
        view.dispatch({
          changes: { from: line.from, to: line.to, insert: newText },
        });
      } catch (err) {
        console.error("Checkbox toggle failed", err);
      }
    };

    span.addEventListener("click", toggle);
    span.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    return span;
  }
  ignoreEvent() { return true; }
}

function checkboxDeco(view) {
  const ranges = [];
  const doc = view.state.doc;
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const m = /^(- )?\[( |x)\]/.exec(line.text);
    if (!m || m.index > 0) continue;
    const from = line.from + m.index;
    const to = from + m[0].length;
    ranges.push(
      Decoration.replace({ widget: new CheckboxWidget(m[2] === "x") }).range(from, to)
    );
  }
  return Decoration.set(ranges);
}

const checkboxPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) { this.decorations = checkboxDeco(view); }
    update(u) { this.decorations = checkboxDeco(u.view); }
  },
  { decorations: (v) => v.decorations }
);

// ---------- / menu (slash completion) ----------

const slashCommands = [
  { label: "/todo", detail: "Todo List", apply: "- [ ] " },
  { label: "/h1", detail: "Heading 1", apply: "# " },
  { label: "/h2", detail: "Heading 2", apply: "## " },
  { label: "/h3", detail: "Heading 3", apply: "### " },
  { label: "/bullet", detail: "Bullet List", apply: "- " },
  { label: "/number", detail: "Numbered List", apply: "1. " },
  { label: "/quote", detail: "Blockquote", apply: "> " },
  {
    label: "/code",
    detail: "Code Block",
    apply: (view, completion, from, to) => {
      view.dispatch({
        changes: { from, to, insert: "```\n\n```" },
        selection: { anchor: from + 4 },
      });
    }
  },
];

function slashCompletionSource(context) {
  const before = context.matchBefore(/\/\w*$/);
  if (!before) return null;
  return { from: before.from, options: slashCommands, filter: true };
}

// ---------- light TUI highlight style ----------

const tuiHighlight = HighlightStyle.define([
  { tag: tags.heading1, class: "cm-md-h1" },
  { tag: tags.heading2, class: "cm-md-h2" },
  { tag: tags.heading3, class: "cm-md-h3" },
  { tag: tags.strong, class: "cm-md-strong" },
  { tag: tags.emphasis, class: "cm-md-em" },
  { tag: tags.monospace, class: "cm-md-code" },
  { tag: tags.link, class: "cm-md-link" },
  { tag: tags.quote, class: "cm-md-quote" },
  { tag: tags.list, class: "cm-md-list" },
]);

// ---------- base theme (light, TUI, no chrome) ----------

const tuiTheme = EditorView.theme(
  {
    "&": {
      backgroundColor: "var(--bg)",
      color: "var(--fg)",
      height: "100%",
      fontSize: "14px",
    },
    ".cm-content": {
      fontFamily: "var(--font)",
      caretColor: "var(--fg)",
      padding: "12px",
      lineHeight: "1.5",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeft: "8px solid var(--fg)", // block caret
    },
    "&.cm-focused": { outline: "none" },
    ".cm-line": { padding: "0" },
    ".cm-scroller": {
      overflow: "auto",
      fontFamily: "var(--font)",
    },
    ".cm-gutters": { display: "none" }, // no gutters
    ".cm-activeLine": { backgroundColor: "transparent" },
    // hidden marks collapse visually
    ".cm-tui-hidden": { fontSize: "0", color: "transparent" },
    ".cm-tui-heading": { fontWeight: "bold" },
    ".cm-tui-strong": { fontWeight: "bold" },
    ".cm-tui-emphasis": { fontStyle: "italic" },
    ".cm-tui-quote": { opacity: "0.6" },
    ".cm-tui-code": {
      backgroundColor: "var(--border)",
      padding: "0 3px",
    },
    // wiki-links
    ".cm-tui-wikilink": {
      color: "var(--fg)",
      textDecoration: "underline",
      cursor: "pointer",
    },
    // checkboxes
    ".cm-tui-checkbox": {
      cursor: "pointer",
      color: "var(--fg)",
      fontFamily: "var(--font)",
      userSelect: "none",
      marginRight: "6px",
    },
    ".cm-tui-checkbox.checked": {
      opacity: 0.5,
    },
    // autocomplete tooltip (TUI styled)
    ".cm-tooltip-autocomplete": {
      border: "1px solid var(--fg) !important",
      borderRadius: "0px !important",
      backgroundColor: "var(--bg) !important",
      fontFamily: "var(--font) !important",
      boxShadow: "none !important",
      zIndex: "10000 !important",
    },
    ".cm-tooltip-autocomplete > ul > li": {
      padding: "3px 8px !important",
      fontFamily: "var(--font) !important",
    },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
      backgroundColor: "var(--fg) !important",
      color: "var(--bg) !important",
    },
    ".cm-completionDetail": {
      fontStyle: "italic",
      opacity: 0.6,
      marginLeft: "8px",
    },
  },
  { dark: false }
);

// ---------- Click handler for wiki-links ----------

function wikiLinkClickHandler(view, pos) {
  const doc = view.state.doc;
  const re = /\[\[([^\]]+)\]\]/g;
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    if (pos < line.from || pos > line.to) continue;
    let m;
    while ((m = re.exec(line.text)) !== null) {
      const from = line.from + m.index;
      const to = from + m[0].length;
      if (pos >= from && pos <= to) {
        return m[1]; // inner name
      }
    }
  }
  return null;
}

function attachWikiLinkHandler(view) {
  view.dom.addEventListener("click", (e) => {
    const target = e.target;
    if (!target.closest(".cm-line")) return;
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
    if (pos === null) return;
    const name = wikiLinkClickHandler(view, pos);
    if (name) {
      e.preventDefault();
      e.stopPropagation();
      // Dispatch custom event that app.js picks up
      view.dom.dispatchEvent(
        new CustomEvent("open-wiki-link", { detail: { name } })
      );
    }
  });
}

// ---------- factory ----------

export function createEditor(parent, onDocChange) {
  const updateListener = EditorView.updateListener.of((u) => {
    if (u.docChanged) onDocChange(u.state.doc.toString());
  });

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: "",
      extensions: [
        history(),
        drawSelection(),
        highlightActiveLine(),
        bracketMatching(),
        indentOnInput(),
        markdown({ base: markdownLanguage }),
        syntaxHighlighting(tuiHighlight),
        markdownStyling,
        wikiLinkPlugin,
        checkboxPlugin,
        autocompletion({ override: [slashCompletionSource] }),
        tuiTheme,
        smartEnter,
        fmtKeymap,
        keymap.of([...defaultKeymap, ...historyKeymap]),
        updateListener,
        EditorView.lineWrapping,
      ],
    }),
  });

  // Expose cmView for formatting helpers
  view.dom.cmView = view;

  // Wiki-link click handler
  attachWikiLinkHandler(view);

  return view;
}
