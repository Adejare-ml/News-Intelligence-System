/**
 * A tiny critically damped spring (Apple's "damping 1.0, response ~0.35s").
 * Interruptible by design: setting a new target keeps the current value and
 * velocity, so motion never jumps when the pointer changes direction.
 */
export class Spring {
  value: number;
  target: number;
  velocity = 0;
  private omega: number;

  constructor(initial = 0, response = 0.35) {
    this.value = initial;
    this.target = initial;
    this.omega = (2 * Math.PI) / response;
  }

  /** Advance by dt seconds (critically damped closed-form step). Returns true while moving. */
  step(dt: number): boolean {
    const w = this.omega;
    const x0 = this.value - this.target;
    const v0 = this.velocity;
    const e = Math.exp(-w * dt);
    const c = v0 + w * x0;
    // x(t) = (x0 + c t) e^{-wt}, so x'(t) = c e^{-wt} - w (x0 + c t) e^{-wt}.
    this.value = this.target + (x0 + c * dt) * e;
    this.velocity = c * e - w * (x0 + c * dt) * e;
    const moving = Math.abs(this.value - this.target) > 1e-3 || Math.abs(this.velocity) > 1e-3;
    if (!moving) {
      this.value = this.target;
      this.velocity = 0;
    }
    return moving;
  }
}
