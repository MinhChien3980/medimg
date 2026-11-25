import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImageViewer2D } from './ImageViewer2D';

/** jsdom never loads images; this stand-in fails every load. */
class FailingImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  decoding = 'auto';
  set src(_url: string) {
    queueMicrotask(() => this.onerror?.());
  }
}

describe('ImageViewer2D', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows a translated message when the image cannot be loaded', async () => {
    vi.stubGlobal('Image', FailingImage);
    const onImageError = vi.fn();

    render(<ImageViewer2D imageUrl="/medimg/broken.png" onImageError={onImageError} />);

    expect(screen.getByRole('status', { name: 'Loading…' })).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the image');
    expect(onImageError).toHaveBeenCalledWith('/medimg/broken.png');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
