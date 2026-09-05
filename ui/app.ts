/**
 * The application.
 *
 * Two things here are worth more attention than the rest.
 *
 * **The note editor sends diffs, not contents.** A textarea gives you the
 * whole string after every keystroke, but writing that string back would be
 * exactly the whole-document overwrite this project exists to avoid. So the
 * editor computes the smallest edit between the previous body and the new one
 * and emits that as insertions and deletions at character positions. One typed
 * letter becomes one operation, and a concurrent edit elsewhere in the note
 * survives it.
 *
 * **The right-hand column is not decoration.** It shows the version vector,
 * the operations waiting on causality and the ones not yet uploaded. In a
 * normal app that would be debug output; here it is the product, because the
 * only way to believe a sync story is to watch the state that drives it.
 */

import { Replica } from "../src/core/replica.js";
import { vvGet } from "../src/core/clock.js";
import { Snapshot, TaskView } from "../src/core/workspace.js";
import { AutoSync, HttpTransport, SyncStats } from "../src/sync/protocol.js";
import { LocalStorageAdapter } from "./storage.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// Each browser tab can act as a separate device: ?device=b gets its own
// replica id and its own log, so one machine can demonstrate a real merge.
const params = new URLSearchParams(location.search);
const deviceName = params.get("device") ?? "a";
const relayUrl = params.get("relay") ?? location.origin;

const storage = new LocalStorageAdapter(deviceName);
const replica = Replica.open(storage);
const transport = new HttpTransport(relayUrl);

let connected = true;
let selectedNote: string | null = null;
let lastRenderedBody = "";
const ledger: { text: string; dir: "in" | "out" | "idle" }[] = [];

const auto = new AutoSync(replica, transport, {
  interval: 1200,
  maxInterval: 15000,
  onSync: (stats) => {
    setLink("synced", describe(stats));
    if (stats.sent || stats.received) {
      note(`${stats.sent ? `↑${stats.sent}` : ""}${stats.received ? ` ↓${stats.received}` : ""}`.trim(),
        stats.received ? "in" : "out");
      render();
    } else {
      render();
    }
  },
  onError: () => {
    setLink("behind", "relay unreachable — still saving locally");
    render();
  },
});

function describe(stats: SyncStats): string {
  if (stats.sent || stats.received) {
    return `sent ${stats.sent}, received ${stats.received}`;
  }
  return "up to date";
}

function note(text: string, dir: "in" | "out" | "idle"): void {
  const time = new Date().toLocaleTimeString([], { hour12: false });
  ledger.unshift({ text: `${time}  ${text}`, dir });
  ledger.splice(40);
}

function setLink(state: "synced" | "behind" | "offline", message: string): void {
  $("pulse").dataset.state = state;
  $("link-status").textContent = message;
}

// -- rendering --------------------------------------------------------------

function render(): void {
  const snapshot = replica.snapshot();
  renderTasks(snapshot);
  renderNotes(snapshot);
  renderLedger();
}

function renderTasks(snapshot: Snapshot): void {
  const list = $("tasks");
  list.textContent = "";
  $("tasks-empty").style.display = snapshot.tasks.length ? "none" : "block";

  for (const task of snapshot.tasks) {
    list.append(taskRow(task));
  }
}

function taskRow(task: TaskView): HTMLLIElement {
  const li = document.createElement("li");
  li.dataset.done = String(task.done);

  const check = document.createElement("input");
  check.type = "checkbox";
  check.checked = task.done;
  check.setAttribute("aria-label", `Mark "${task.title}" done`);
  check.onchange = () => act(() => replica.setTask(task.id, "done", check.checked));

  const body = document.createElement("div");
  body.className = "task-body";
  const title = document.createElement("div");
  title.className = "task-title";
  title.textContent = task.title;
  body.append(title);

  for (const conflict of task.conflicts) {
    body.append(conflictBlock(task, conflict));
  }

  const tools = document.createElement("div");
  tools.className = "task-tools";
  const rename = document.createElement("button");
  rename.textContent = "rename";
  rename.onclick = () => {
    const next = prompt("New title", task.title);
    if (next !== null) act(() => replica.setTask(task.id, "title", next));
  };
  const remove = document.createElement("button");
  remove.textContent = "delete";
  remove.onclick = () => act(() => replica.removeTask(task.id));
  tools.append(rename, remove);

  li.append(check, body, tools);
  return li;
}

function conflictBlock(task: TaskView, conflict: TaskView["conflicts"][number]): HTMLDivElement {
  const box = document.createElement("div");
  box.className = "conflict";

  const heading = document.createElement("p");
  heading.textContent = `Two devices changed "${conflict.field}" at the same time. Both are kept until you pick one.`;
  box.append(heading);

  for (const value of [conflict.chosen, ...conflict.alternatives]) {
    const row = document.createElement("div");
    row.className = "choice";
    const label = document.createElement("span");
    label.textContent = String(value);
    const keep = document.createElement("button");
    keep.textContent = "Keep this";
    // Resolving is an ordinary write. It observes every competing value, so
    // the register collapses to one on this device and on every other.
    keep.onclick = () => act(() => replica.setTask(task.id, conflict.field, value as string));
    row.append(label, keep);
    box.append(row);
  }
  return box;
}

function renderNotes(snapshot: Snapshot): void {
  const list = $("note-list");
  list.textContent = "";

  const add = document.createElement("button");
  add.textContent = "+ New note";
  add.onclick = () => {
    const title = prompt("Note title", "Untitled");
    if (title === null) return;
    act(() => {
      selectedNote = replica.createNote(title);
      lastRenderedBody = "";
    });
  };
  list.append(add);

  for (const n of snapshot.notes) {
    const button = document.createElement("button");
    button.textContent = n.title || "Untitled";
    button.setAttribute("aria-current", String(n.id === selectedNote));
    button.onclick = () => {
      selectedNote = n.id;
      lastRenderedBody = "";
      render();
    };
    list.append(button);
  }

  if (selectedNote && !snapshot.notes.some((n) => n.id === selectedNote)) selectedNote = null;
  if (!selectedNote && snapshot.notes.length) selectedNote = snapshot.notes[0].id;

  const editor = $<HTMLTextAreaElement>("note-body");
  const current = snapshot.notes.find((n) => n.id === selectedNote);
  editor.disabled = !current;

  if (current && current.body !== lastRenderedBody) {
    // Only touch the textarea when the merged text actually differs from what
    // it is showing, and put the caret back where it was. Rewriting it on
    // every sync would fight the person typing into it.
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const grew = current.body.length - editor.value.length;
    editor.value = current.body;
    lastRenderedBody = current.body;
    if (document.activeElement === editor) {
      const shift = start >= editor.value.length - Math.max(grew, 0) ? grew : 0;
      editor.setSelectionRange(start + shift, end + shift);
    }
  } else if (!current) {
    editor.value = "";
    lastRenderedBody = "";
  }

  $("note-hint").textContent = current
    ? `Edits merge per character. Open a second device and type in the same note while both are connected.`
    : "";
}

function renderLedger(): void {
  const version = replica.version;
  const peer = replica.peerVersion("relay");

  $("s-ops").textContent = String(replica.log.size);
  $("s-pending").textContent = String(replica.log.pendingCount);
  $("s-unsent").textContent = String(replica.since(peer).length);
  $("s-bytes").textContent = `${(storage.bytes / 1024).toFixed(1)} KB`;

  const vv = $("vv");
  vv.textContent = "";
  const replicas = Object.keys(version).sort();
  if (!replicas.length) {
    const row = document.createElement("div");
    row.textContent = "no operations yet";
    vv.append(row);
  }
  for (const id of replicas) {
    const row = document.createElement("div");
    if (id === replica.id) row.className = "self";
    const name = document.createElement("span");
    name.textContent = id === replica.id ? `${id.slice(0, 8)} (this device)` : id.slice(0, 8);
    const seq = document.createElement("span");
    // Showing the relay's count beside our own makes "behind" visible rather
    // than something you infer from a spinner.
    seq.textContent = `${version[id]}${vvGet(peer, id) < version[id] ? " ↑" : ""}`;
    row.append(name, seq);
    vv.append(row);
  }

  const log = $("ledger");
  log.textContent = "";
  for (const entry of ledger) {
    const row = document.createElement("div");
    row.className = entry.dir;
    row.textContent = entry.text;
    log.append(row);
  }
}

/** Run a mutation, then re-render. Every edit is local and immediate. */
function act(fn: () => void): void {
  fn();
  render();
}

// -- input ------------------------------------------------------------------

$("add-task").onclick = addTask;
$<HTMLInputElement>("new-task").onkeydown = (e) => {
  if ((e as KeyboardEvent).key === "Enter") addTask();
};

function addTask(): void {
  const input = $<HTMLInputElement>("new-task");
  const title = input.value.trim();
  if (!title) return;
  input.value = "";
  act(() => replica.createTask(title));
}

/**
 * Translate a textarea's new contents into the smallest edit that explains it.
 *
 * Common prefix and suffix, then one deletion and one insertion in the middle.
 * This is not an attempt at a clever diff — it is the minimum needed so that
 * ordinary typing produces one operation per character instead of replacing
 * the document, which is what would destroy a concurrent edit.
 */
$<HTMLTextAreaElement>("note-body").oninput = () => {
  if (!selectedNote) return;
  const editor = $<HTMLTextAreaElement>("note-body");
  const before = lastRenderedBody;
  const after = editor.value;
  if (before === after) return;

  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++;
  }

  const removed = before.length - prefix - suffix;
  const inserted = after.slice(prefix, after.length - suffix);

  if (removed > 0) replica.deleteText(selectedNote, prefix, prefix + removed);
  if (inserted) replica.insertText(selectedNote, prefix, inserted);
  lastRenderedBody = after;
  renderLedger();
};

$("toggle-link").onclick = () => {
  connected = !connected;
  const button = $<HTMLButtonElement>("toggle-link");
  button.dataset.on = String(connected);
  button.textContent = connected ? "Connected" : "Offline";
  if (connected) {
    auto.start();
    setLink("behind", "reconnecting");
    note("went online", "idle");
  } else {
    auto.stop();
    setLink("offline", "offline — edits are saved here");
    note("went offline", "idle");
  }
  render();
};

$("wipe").onclick = () => {
  if (!confirm("Erase this device's local data? Synced work returns from the relay.")) return;
  storage.wipe();
  location.reload();
};

// -- start ------------------------------------------------------------------

$("device-label").textContent = `device ${deviceName} · ${replica.id.slice(0, 8)}`;
const other = deviceName === "a" ? "b" : "a";
const link = document.createElement("a");
link.href = `?device=${other}`;
link.target = "_blank";
link.textContent = `Open device ${other} in a new tab`;
$("second-device").append(link, document.createTextNode(" to watch two devices merge."));

note("opened", "idle");
render();
auto.start();
