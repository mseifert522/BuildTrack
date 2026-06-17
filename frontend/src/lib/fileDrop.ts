import type { DragEvent } from 'react';

type DropTargetElement = HTMLElement & {
  classList: DOMTokenList;
};

export type FileDropOptions = {
  accept?: string;
  disabled?: boolean;
  multiple?: boolean;
};

const IMAGE_EXTENSION_PATTERN = /\.(avif|bmp|dib|gif|heic|heif|jpe?g|jfif|pjpeg|pjp|png|tiff?|webp|dng)$/i;
const VIDEO_EXTENSION_PATTERN = /\.(mp4|mov|qt|m4v|webm|avi|mkv|mpe?g|3gp|3g2|hevc|mts|m2ts)$/i;

function hasFiles(event: DragEvent) {
  return Array.from(event.dataTransfer?.types || []).includes('Files');
}

function fileMatchesAccept(file: File, accept = '') {
  const rules = accept.split(',').map(rule => rule.trim().toLowerCase()).filter(Boolean);
  if (!rules.length) return true;

  const type = String(file.type || '').toLowerCase();
  const name = String(file.name || '').toLowerCase();

  return rules.some(rule => {
    if (rule === '*/*') return true;
    if (rule === 'image/*') return type.startsWith('image/') || IMAGE_EXTENSION_PATTERN.test(name);
    if (rule === 'video/*') return type.startsWith('video/') || VIDEO_EXTENSION_PATTERN.test(name);
    if (rule.endsWith('/*')) return type.startsWith(rule.slice(0, -1));
    if (rule.startsWith('.')) return name.endsWith(rule);
    return type === rule;
  });
}

function clearDropState(target: EventTarget | null) {
  if (target instanceof HTMLElement) {
    target.classList.remove('bt-file-drop-active');
  }
}

export function droppedFiles(event: DragEvent, options: FileDropOptions = {}) {
  const files = Array.from(event.dataTransfer?.files || [])
    .filter(file => fileMatchesAccept(file, options.accept));
  return options.multiple === false ? files.slice(0, 1) : files;
}

export function fileDropHandlers(
  onFiles: (files: File[]) => void,
  options: FileDropOptions = {}
) {
  return {
    onDragEnter: (event: DragEvent<DropTargetElement>) => {
      if (options.disabled || !hasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.classList.add('bt-file-drop-active');
    },
    onDragOver: (event: DragEvent<DropTargetElement>) => {
      if (options.disabled || !hasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'copy';
      event.currentTarget.classList.add('bt-file-drop-active');
    },
    onDragLeave: (event: DragEvent<DropTargetElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
        clearDropState(event.currentTarget);
      }
    },
    onDrop: (event: DragEvent<DropTargetElement>) => {
      if (options.disabled || !hasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      clearDropState(event.currentTarget);
      const files = droppedFiles(event, options);
      if (files.length) onFiles(files);
    },
  };
}
