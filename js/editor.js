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
} from "@codemirror/language";
import { tags } from "@lezer/highlight";

// ---------- formatting helpers ----------

function wrapSelection(view, before, after) {
  const changes = [];
  for (const range of view.state.selection.ranges) {
    if (range.empty) {
      // No selection: insert markers and put cursor between
      const ins = before + after;
      changes.push({ from: range.from, insert: ins });
    } else {
      const text = view.state.sliceDoc(range.from, range.to);
      // Toggle: if already wrapped, unwrap
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
        changes.push({
          from: range.from,
          to: range.to,
          insert: before + text + after,
        });
      }
    }
  }
  const tr = view.state.update({ changes, userEvent: "input" });
  view.dispatch(tr);
  view.focus();
  return true;
}

const fmtKeymap = keymap.of([
  { key: "Mod-b", run: (v) => wrapSelection(v, "**", "**") },
  { key: "Mod-i", run: (v) => wrapSelection(v, "*", "*") },
  { key: "Mod-k", run: (v) => wrapSelection(v, "`", "`") },
]);

// ---------- smart Enter: continue lists / quotes / headings ----------

function continueList({ state, dispatch }) {
  const { from } = state.selection.main;
  const line = state.doc.lineAt(from);
  const text = line.text;

  // Don't continue on empty list items — exit the list instead
  const emptyItem = /^(\s*)([-*+]|\d+\.)\s+$/.exec(text);
  if (emptyItem) {
    const changes = {
      from: line.from,
      to: line.to,
      insert: "",
    };
    dispatch(
      state.update({ changes, selection: { anchor: line.from } })
    );
    return true;
  }

  // Unordered list
  let m = /^(\s*)([-*+])\s+/.exec(text);
  if (m) {
    const insert = `\n${m[1]}${m[2]} `;
    dispatch(
      state.update({
        changes: { from, insert },
        selection: { anchor: from + insert.length },
      })
    );
    return true;
  }

  // Ordered list — auto-increment
  m = /^(\s*)(\d+)\.\s+/.exec(text);
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

  // Blockquote
  m = /^(\s*>\s?)+/.exec(text);
  if (m) {
    const insert = `\n${m[0]}`;
    dispatch(
      state.update({
        changes: { from, insert },
        selection: { anchor: from + insert.length },
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
          // Keep visible if selection/cursor overlaps the mark
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
  // Sort by position — CM requires ranges in order
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
  },
  { dark: false }
);

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
        markdown({ base: markdownLanguage }),
        syntaxHighlighting(tuiHighlight),
        markdownStyling,
        tuiTheme,
        smartEnter,
        fmtKeymap,
        keymap.of([...markdownKeymap, ...defaultKeymap, ...historyKeymap]),
        updateListener,
        EditorView.lineWrapping,
      ],
    }),
  });
  return view;
}
