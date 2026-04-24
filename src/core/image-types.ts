export const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png'] as const;
export type ImageExtension = (typeof IMAGE_EXTENSIONS)[number];

export type FileKind = 'image' | 'pdf';

export function isImageFile(name: string): boolean {
  const lower = name.toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function isPdfFile(name: string): boolean {
  return name.toLowerCase().endsWith('.pdf');
}

export function classifyFile(name: string): FileKind | undefined {
  if (isImageFile(name)) return 'image';
  if (isPdfFile(name)) return 'pdf';
  return undefined;
}

export function imageMimeFromExtension(name: string): 'image/jpeg' | 'image/png' | undefined {
  const lower = name.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.png')) return 'image/png';
  return undefined;
}
