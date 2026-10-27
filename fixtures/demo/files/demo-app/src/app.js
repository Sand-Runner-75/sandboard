// The demo app's entry point: reads the task list and shows it.
import { readList } from "./list.js";

export function start(view) {
  const list = readList();
  view.show(list.map(task => task.id + " " + task.title));
}
