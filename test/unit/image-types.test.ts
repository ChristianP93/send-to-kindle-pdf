import { describe, expect, it } from 'vitest';

import {
  classifyFile,
  imageMimeFromExtension,
  isImageFile,
  isPdfFile,
} from '../../src/core/image-types.js';

describe('isImageFile', () => {
  it('accepts jpg, jpeg, png case-insensitive', () => {
    expect(isImageFile('a.jpg')).toBe(true);
    expect(isImageFile('a.JPG')).toBe(true);
    expect(isImageFile('a.Jpeg')).toBe(true);
    expect(isImageFile('a.PNG')).toBe(true);
    expect(isImageFile('1.jpg')).toBe(true);
  });

  it('rejects unsupported formats', () => {
    expect(isImageFile('a.webp')).toBe(false);
    expect(isImageFile('a.tiff')).toBe(false);
    expect(isImageFile('a.gif')).toBe(false);
    expect(isImageFile('a.bmp')).toBe(false);
    expect(isImageFile('noext')).toBe(false);
    expect(isImageFile('')).toBe(false);
  });
});

describe('isPdfFile', () => {
  it('is case-insensitive', () => {
    expect(isPdfFile('a.pdf')).toBe(true);
    expect(isPdfFile('a.PDF')).toBe(true);
    expect(isPdfFile('a.Pdf')).toBe(true);
  });

  it('rejects non-PDFs', () => {
    expect(isPdfFile('a.jpg')).toBe(false);
    expect(isPdfFile('pdf')).toBe(false);
  });
});

describe('classifyFile', () => {
  it('returns image/pdf/undefined', () => {
    expect(classifyFile('cover.jpg')).toBe('image');
    expect(classifyFile('doc.pdf')).toBe('pdf');
    expect(classifyFile('note.txt')).toBeUndefined();
  });
});

describe('imageMimeFromExtension', () => {
  it('maps to mime types', () => {
    expect(imageMimeFromExtension('a.jpg')).toBe('image/jpeg');
    expect(imageMimeFromExtension('a.jpeg')).toBe('image/jpeg');
    expect(imageMimeFromExtension('a.png')).toBe('image/png');
    expect(imageMimeFromExtension('a.webp')).toBeUndefined();
  });
});
