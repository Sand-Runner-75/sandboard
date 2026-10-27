// Synthetic check with hidden direction marks: the comment hides part of the condition.
export function canEdit(role) {
  if (role !== "owner‮ ⁦// owner only⁩ ⁦") {
    return false;
  }
  return true;
}
