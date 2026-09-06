import { describe, expect, it } from 'vitest';
import { Input } from '../src/core/Input';

describe('Input', () => {
  it('maps keys to analog driving actions with steer smoothing', () => {
    const input = new Input();
    input.setKey('KeyW', true);
    input.setKey('KeyD', true);
    const s1 = input.poll(1 / 60);
    expect(s1.throttle).toBe(1);
    expect(s1.brake).toBe(0);
    expect(s1.steer).toBeGreaterThan(0);
    expect(s1.steer).toBeLessThan(1); // ramps up over time
    for (let i = 0; i < 60; i++) input.poll(1 / 60);
    expect(input.state.steer).toBe(1);
    input.setKey('KeyD', false);
    for (let i = 0; i < 30; i++) input.poll(1 / 60);
    expect(input.state.steer).toBe(0);
    expect(input.state.moveY).toBe(1);
    input.setKey('KeyW', false);
    input.setKey('ArrowDown', true);
    input.poll(1 / 60);
    expect(input.state.brake).toBe(1);
    expect(input.state.moveY).toBe(-1);
  });

  it('edge-triggers interact/pause/quality once per press', () => {
    const input = new Input();
    input.setKey('KeyE', true);
    expect(input.poll(1 / 60).interactPressed).toBe(true);
    expect(input.poll(1 / 60).interactPressed).toBe(false);
    input.setKey('KeyE', true); // still held: no new edge
    expect(input.poll(1 / 60).interactPressed).toBe(false);
    input.setKey('KeyE', false);
    input.setKey('KeyE', true);
    expect(input.poll(1 / 60).interactPressed).toBe(true);
    input.setKey('Digit3', true);
    expect(input.poll(1 / 60).qualityPressed).toBe(3);
    expect(input.poll(1 / 60).qualityPressed).toBe(0);
    input.setKey('Escape', true);
    expect(input.poll(1 / 60).pausePressed).toBe(true);
  });

  it('accumulates look deltas until polled and honours virtual inputs', () => {
    const input = new Input();
    input.addLook(3, -2);
    input.addLook(1, 1);
    const s = input.poll(1 / 60);
    expect(s.lookDX).toBe(4);
    expect(s.lookDY).toBe(-1);
    expect(input.poll(1 / 60).lookDX).toBe(0);
    input.virtual.throttle = 0.5;
    input.virtual.steer = -0.25;
    input.virtual.handbrake = true;
    const v = input.poll(1 / 60);
    expect(v.throttle).toBe(0.5);
    expect(v.steer).toBe(-0.25);
    expect(v.handbrake).toBe(true);
  });
});
