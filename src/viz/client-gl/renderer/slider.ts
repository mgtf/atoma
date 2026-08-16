/**
 * Pixi slider control for tuning parameters in the detail pane.
 *
 * A slider is a horizontal track with a draggable thumb, drawn as two Graphics
 * objects. The value is clamped to [min, max] and quantized by step if given.
 */

import { Container, Graphics, Rectangle, type FederatedPointerEvent } from 'pixi.js';

export interface SliderConfig {
  x: number;
  y: number;
  width: number;
  height: number;
  min: number;
  max: number;
  step?: number;
  initialValue: number;
  onChange?: (value: number) => void;
}

export class Slider extends Container {
  private track: Graphics;
  private thumb: Graphics;
  private config: SliderConfig;
  private _value: number;

  constructor(config: SliderConfig) {
    super();
    this.config = config;
    this._value = Math.max(config.min, Math.min(config.max, config.initialValue));

    this.position.set(config.x, config.y);
    this.hitArea = new Rectangle(0, 0, config.width, config.height);
    this.eventMode = 'static';

    this.track = new Graphics();
    this.track.roundRect(0, config.height / 2 - 2, config.width, 4, 2);
    this.track.fill({ color: 0x1f2937, alpha: 0.6 });
    this.addChild(this.track);

    this.thumb = new Graphics();
    this.updateThumbPosition();
    this.addChild(this.thumb);

    this.on('pointerdown', (e: FederatedPointerEvent) => {
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      activeSlider = this;
      const event = { global: { x: e.global.x, y: e.global.y } };
      this.updateFromPointer(event);
    });
  }

  private updateThumbPosition() {
    const thumbX = ((this._value - this.config.min) / (this.config.max - this.config.min)) *
      this.config.width - 6;
    this.thumb.clear();
    this.thumb.roundRect(thumbX, this.config.height / 2 - 6, 12, 12, 3);
    this.thumb.fill({ color: 0x38bdf8, alpha: 0.9 });
    this.thumb.stroke({ color: 0x60a5fa, width: 1, alpha: 0.8 });
  }

  private updateFromPointer(e: { global: { x: number; y: number } }) {
    const globalPoint = e.global;
    const localX = globalPoint.x - this.getGlobalPosition().x;
    const clampedX = Math.max(0, Math.min(this.config.width, localX));
    let value = this.config.min +
      (clampedX / this.config.width) * (this.config.max - this.config.min);

    if (this.config.step) {
      value = Math.round(value / this.config.step) * this.config.step;
    }

    if (value !== this._value) {
      this._value = value;
      this.updateThumbPosition();
      this.config.onChange?.(this._value);
    }
  }

  set value(v: number) {
    this._value = Math.max(this.config.min, Math.min(this.config.max, v));
    this.updateThumbPosition();
  }

  get value() {
    return this._value;
  }
}

// Global pointer up/move listeners for dragging across the screen
let activeSlider: Slider | null = null;

if (typeof window !== 'undefined') {
  window.addEventListener('pointermove', (e: Event) => {
    if (activeSlider && e instanceof PointerEvent) {
      const event = { global: { x: e.clientX, y: e.clientY } };
      activeSlider['updateFromPointer'](event);
    }
  });

  window.addEventListener('pointerup', () => {
    activeSlider = null;
  });
}
