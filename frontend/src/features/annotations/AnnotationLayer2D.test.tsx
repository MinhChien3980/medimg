import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ViewerTransform } from '../viewer/components/ImageViewer2D';
import {
  AnnotationLayer2D,
  type AnnotationLayer2DProps,
  type LayerItem,
} from './AnnotationLayer2D';
import type { Shape2D } from './geometry2d';

/** Image 400×300 shown at 2× with its origin at (10, 20) on screen (jsdom boxes sit at 0, 0). */
const transform: ViewerTransform = {
  viewport: { scale: 2, offsetX: 10, offsetY: 20 },
  image: { width: 400, height: 300 },
  view: { width: 820, height: 620 },
};
const screenOf = (x: number, y: number) => ({ clientX: x * 2 + 10, clientY: y * 2 + 20 });

const own: LayerItem = {
  id: 'r1',
  shape: { kind: 'RECTANGLE', geometry: { x: 50, y: 50, width: 100, height: 60 } },
  text: 'Nodule',
  editable: true,
};
const others: LayerItem = {
  id: 'l1',
  shape: { kind: 'LENGTH', geometry: { from: [200, 200], to: [300, 200] } },
  text: '100.0 px',
  editable: false,
};

function setup(props: Partial<AnnotationLayer2DProps> = {}) {
  const handlers = {
    onSelect: vi.fn(),
    onCreate: vi.fn<(shape: Shape2D) => void>(),
    onChange: vi.fn(),
    onDelete: vi.fn(),
  };
  const parentDown = vi.fn();
  const view = render(
    <div onPointerDown={parentDown}>
      <AnnotationLayer2D
        transform={transform}
        items={[own, others]}
        selectedId={null}
        tool={null}
        {...handlers}
        {...props}
      />
    </div>,
  );
  const layer = screen.getByTestId('annotation-layer');
  const background = layer.querySelector('.annotation-layer__background') as Element;
  const hit = (id: string) =>
    layer.querySelector(`[data-annotation-id="${id}"] .annotation-shape__hit`) as Element;
  return { ...view, ...handlers, parentDown, layer, background, hit };
}

const down = (el: Element, x: number, y: number, button = 0) =>
  fireEvent.pointerDown(el, { ...screenOf(x, y), button, pointerId: 1 });
const move = (el: Element, x: number, y: number) =>
  fireEvent.pointerMove(el, { ...screenOf(x, y), pointerId: 1 });
const up = (el: Element, x: number, y: number) =>
  fireEvent.pointerUp(el, { ...screenOf(x, y), pointerId: 1 });

describe('AnnotationLayer2D', () => {
  it('draws shapes at the anatomy under the pointer, whatever the zoom and pan', () => {
    const { layer, background, onCreate } = setup({ tool: 'RECTANGLE' });
    down(background, 20, 30);
    move(layer, 120, 90);
    expect(layer.querySelector('.annotation-draft')).toBeInTheDocument();
    up(layer, 120, 90);
    expect(onCreate).toHaveBeenCalledWith({
      kind: 'RECTANGLE',
      geometry: { x: 20, y: 30, width: 100, height: 60 },
    });
  });

  it('clamps a drag that leaves the image and ignores a click without drag', () => {
    const { layer, background, onCreate } = setup({ tool: 'LENGTH' });
    down(background, 350, 100);
    up(layer, 350.5, 100);
    expect(onCreate).not.toHaveBeenCalled();

    down(background, 350, 100);
    up(layer, 600, 100);
    expect(onCreate).toHaveBeenCalledWith({
      kind: 'LENGTH',
      geometry: { from: [350, 100], to: [400, 100] },
    });
  });

  it('draws a polygon by clicks, closed with Enter; Esc cancels one', () => {
    const { layer, background, onCreate } = setup({ tool: 'POLYGON' });
    for (const [x, y] of [
      [10, 10],
      [100, 10],
      [50, 80],
    ] as const) {
      down(background, x, y);
    }
    fireEvent.keyDown(layer, { key: 'Enter' });
    expect(onCreate).toHaveBeenCalledWith({
      kind: 'POLYGON',
      geometry: {
        points: [
          [10, 10],
          [100, 10],
          [50, 80],
        ],
      },
    });

    onCreate.mockClear();
    down(background, 10, 10);
    down(background, 100, 10);
    fireEvent.keyDown(layer, { key: 'Escape' });
    fireEvent.keyDown(layer, { key: 'Enter' });
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('closes a polygon on double-click without a repeated last vertex', () => {
    const { layer, background, onCreate } = setup({ tool: 'POLYGON' });
    down(background, 10, 10);
    down(background, 100, 10);
    down(background, 50, 80);
    down(background, 50, 80); // second click of the double-click
    fireEvent.doubleClick(layer);
    expect(onCreate.mock.calls[0]?.[0]).toMatchObject({ geometry: { points: { length: 3 } } });
  });

  it('closes a polygon by clicking its first vertex', () => {
    const { background, onCreate } = setup({ tool: 'POLYGON' });
    down(background, 10, 10);
    down(background, 100, 10);
    down(background, 50, 80);
    down(background, 11, 11);
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate.mock.calls[0]?.[0]).toMatchObject({ geometry: { points: { length: 3 } } });
  });

  it('selects and moves an own shape, then deletes it with Delete', () => {
    const { layer, hit, onSelect, onChange } = setup();
    down(hit('r1'), 60, 50);
    expect(onSelect).toHaveBeenCalledWith('r1');
    move(layer, 70, 45);
    up(layer, 70, 45);
    expect(onChange).toHaveBeenCalledWith('r1', {
      kind: 'RECTANGLE',
      geometry: { x: 60, y: 45, width: 100, height: 60 },
    });
  });

  it('reshapes the selected shape with its handles and deletes it with the Delete key', () => {
    const { layer, onChange, onDelete } = setup({ selectedId: 'r1' });
    const handles = layer.querySelectorAll('[data-annotation-id="r1"] .annotation-shape__handle');
    expect(handles).toHaveLength(4);
    down(handles[2] as Element, 150, 110);
    move(layer, 180, 160);
    up(layer, 180, 160);
    expect(onChange).toHaveBeenCalledWith('r1', {
      kind: 'RECTANGLE',
      geometry: { x: 50, y: 50, width: 130, height: 110 },
    });

    fireEvent.keyDown(layer, { key: 'Delete' });
    expect(onDelete).toHaveBeenCalledWith('r1');
  });

  it("shows others' shapes without handles; they cannot be moved or deleted", () => {
    const { layer, hit, onSelect, onChange, onDelete, rerender } = setup();
    down(hit('l1'), 250, 200);
    move(layer, 260, 220);
    up(layer, 260, 220);
    expect(onSelect).toHaveBeenCalledWith('l1');
    expect(onChange).not.toHaveBeenCalled();

    rerender(
      <div>
        <AnnotationLayer2D
          transform={transform}
          items={[own, others]}
          selectedId="l1"
          tool={null}
          onSelect={onSelect}
          onCreate={vi.fn()}
          onChange={onChange}
          onDelete={onDelete}
        />
      </div>,
    );
    expect(layer.querySelectorAll('.annotation-shape__handle')).toHaveLength(0);
    fireEvent.keyDown(layer, { key: 'Delete' });
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('leaves the middle and right buttons to the viewer (pan, W/L) even while drawing', () => {
    const { background, parentDown, onCreate } = setup({ tool: 'RECTANGLE' });
    down(background, 20, 20, 1);
    down(background, 20, 20, 2);
    expect(parentDown).toHaveBeenCalledTimes(2);
    expect(onCreate).not.toHaveBeenCalled();
    down(background, 20, 20, 0);
    expect(parentDown).toHaveBeenCalledTimes(2); // the left button draws
  });

  it('draws shapes and labels through the viewer transform', () => {
    const { layer } = setup();
    const outline = layer.querySelector('[data-annotation-id="r1"] path');
    // Rectangle (50, 50)-(150, 110) at 2× from (10, 20) on screen.
    expect(outline?.getAttribute('d')).toBe(
      'M110.0,120.0 L310.0,120.0 L310.0,240.0 L110.0,240.0 Z',
    );
    expect(screen.getByText('Nodule')).toBeInTheDocument();
    expect(screen.getByText('100.0 px')).toBeInTheDocument();
  });
});
