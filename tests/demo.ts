/**
 * A narrated run of the thing the project claims to do.
 *
 * `npm run demo`. No assertions here — the tests do that. This exists so the
 * behaviour can be watched rather than inferred from a passing suite.
 */

import { Replica } from "../src/core/replica.js";
import { MemoryStorage } from "../src/storage/storage.js";
import { DirectTransport, RelayStore, sync } from "../src/sync/protocol.js";

const relay = new RelayStore();
const transport = new DirectTransport(relay);
const laptop = Replica.open(new MemoryStorage());
const phone = Replica.open(new MemoryStorage());

const bar = "─".repeat(66);
const show = (label: string) => {
  console.log(`\n${label}\n${bar}`);
  for (const [name, replica] of [
    ["laptop", laptop],
    ["phone ", phone],
  ] as const) {
    const s = replica.snapshot();
    const tasks = s.tasks
      .map((t) => `${t.done ? "[x]" : "[ ]"} ${t.title}${t.conflicts.length ? "  ⚠" : ""}`)
      .join("\n           ");
    console.log(`  ${name}   ${tasks || "(no tasks)"}`);
    for (const n of s.notes) console.log(`           note "${n.title}": ${JSON.stringify(n.body)}`);
    for (const t of s.tasks) {
      for (const c of t.conflicts) {
        console.log(
          `           ⚠ "${c.field}" has ${1 + c.alternatives.length} versions: ` +
            [c.chosen, ...c.alternatives].map((v) => JSON.stringify(v)).join(" | "),
        );
      }
    }
  }
};

const settle = async () => {
  for (let i = 0; i < 3; i++) {
    await sync(laptop, transport);
    await sync(phone, transport);
  }
};

console.log("Tether — offline-first merge demo");

const task = laptop.createTask("Book the flights");
const note = laptop.createNote("Trip", "fly out monday");
await settle();
show("1. Both devices start in sync");

console.log("\n2. The network goes away. Both keep working.");
laptop.setTask(task, "title", "Book the flights and the hotel");
laptop.insertText(note, 0, "PLAN: ");
phone.setTask(task, "done", true);
phone.insertText(note, "fly out monday".length, ", back friday");
show("   ...while still apart");

await settle();
show("3. Reconnected");

console.log("\n   Nothing was overwritten: the laptop's rename, the phone's tick,");
console.log("   and both ends of the note all survived.");

console.log("\n4. Now a real conflict — the same field, at the same time.");
laptop.setTask(task, "title", "Book flights, hotel, and car");
phone.setTask(task, "title", "Book flights and the airbnb");
await settle();
show("   Both versions are kept and both devices agree on which to show");

console.log("\n5. Someone picks one. That is an ordinary edit, and it collapses the conflict.");
phone.setTask(task, "title", "Book flights and the airbnb, plus a car");
await settle();
show("   Resolved everywhere");

const identical = JSON.stringify(laptop.snapshot()) === JSON.stringify(phone.snapshot());
console.log(`\nStates identical: ${identical}`);
console.log(`Operations exchanged in total: ${relay.size}`);
console.log(
  `Laptop version vector: ${JSON.stringify(laptop.version)}\nPhone  version vector: ${JSON.stringify(phone.version)}`,
);
