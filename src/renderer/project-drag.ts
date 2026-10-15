import type { DragEvent } from 'react';
export const projectDragType = 'application/reqflow-project';
export function projectDrop(event: DragEvent<HTMLElement>, target: string, act: (action: any) => Promise<unknown>) {
  event.preventDefault(); event.stopPropagation();
  event.currentTarget.classList.remove('project-drop-before', 'project-drop-after');
  const id = event.dataTransfer.getData(projectDragType);
  if (!id || id === target) return;
  const rect = event.currentTarget.getBoundingClientRect();
  void act({ op: 'projectReorder', project: id, target, position: event.clientY < rect.top + rect.height / 2 ? 'before' : 'after' });
}
export function projectDragOver(event: DragEvent<HTMLElement>) {
  if (!event.dataTransfer.types.includes(projectDragType)) return;
  event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move';
  const before = event.clientY < event.currentTarget.getBoundingClientRect().top + event.currentTarget.offsetHeight / 2;
  event.currentTarget.classList.toggle('project-drop-before', before);
  event.currentTarget.classList.toggle('project-drop-after', !before);
}
export function projectDragLeave(event: DragEvent<HTMLElement>) {
  if (!event.currentTarget.contains(event.relatedTarget as Node)) event.currentTarget.classList.remove('project-drop-before', 'project-drop-after');
}

export function projectDragEnd() {
  document.querySelectorAll('.project-drop-before, .project-drop-after').forEach(el => el.classList.remove('project-drop-before', 'project-drop-after'));
}
