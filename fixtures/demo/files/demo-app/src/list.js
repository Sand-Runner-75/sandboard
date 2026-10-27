// The task list, read from the plan's progress file.
export function readList(doc) {
  if (!doc || !Array.isArray(doc.tasks)) return [];
  return doc.tasks.filter(task => task.status !== "Removed");
}
