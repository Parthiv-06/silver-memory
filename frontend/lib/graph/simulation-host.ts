import {
  createSimulationRuntime,
  type ForceParams,
  type SimFrame,
  type SimRequest,
  type SimulationInput,
} from "./simulation";

/**
 * Runs the layout in a Web Worker, or on the main thread (one step per animation frame) when a
 * worker can't be created or fails to load. Both paths share the same runtime and message protocol.
 */
export class SimulationHost {
  mode: "worker" | "main" = "worker";
  private worker: Worker | null = null;
  private local: ((request: SimRequest) => void) | null = null;
  private version = 0;
  private replay: SimulationInput | null = null;
  private snapshot: Float32Array | null = null;
  private disposed = false;

  constructor(private readonly onFrame: (frame: SimFrame) => void) {
    try {
      this.worker = new Worker(new URL("./simulation.worker.ts", import.meta.url), { type: "module" });
      this.worker.onmessage = (event: MessageEvent<SimFrame>) => this.receive(event.data);
      this.worker.onerror = (event) => {
        event.preventDefault();
        this.fallback();
      };
    } catch {
      this.fallback();
    }
  }

  init(input: SimulationInput): void {
    this.version++;
    this.replay = { ...input, positions: input.positions.slice() };
    this.snapshot = null;
    // Not transferred: the caller keeps using its edge arrays for drawing.
    this.send({ type: "init", version: this.version, ...input });
  }

  /** Ends the current layout; frames already in flight are dropped. */
  stop(): void {
    this.version++;
    this.replay = null;
    this.snapshot = null;
    this.send({ type: "stop" });
  }

  setForces(forces: Partial<ForceParams>, reheat?: number): void {
    if (this.replay) this.replay.forces = { ...this.replay.forces, ...forces };
    this.send({ type: "setForces", forces, reheat });
  }

  pin(index: number, x: number, y: number): void {
    this.send({ type: "pin", index, x, y });
  }

  unpin(index: number): void {
    this.send({ type: "unpin", index });
  }

  reheat(alpha = 1): void {
    this.send({ type: "reheat", alpha });
  }

  /** Hands a drawn frame's buffer back so the runtime can fill it again. */
  recycle(frame: SimFrame): void {
    if (frame.version !== this.version) return;
    const request: SimRequest = { type: "recycle", version: frame.version, positions: frame.positions };
    if (this.worker) this.worker.postMessage(request, [frame.positions.buffer]);
    else this.local?.(request);
  }

  dispose(): void {
    this.disposed = true;
    this.send({ type: "stop" });
    this.worker?.terminate();
    this.worker = null;
    this.local = null;
  }

  private send(request: SimRequest): void {
    if (this.disposed && request.type !== "stop") return;
    if (this.worker) this.worker.postMessage(request);
    else this.local?.(request);
  }

  private receive(frame: SimFrame): void {
    if (this.disposed || frame.version !== this.version) return;
    if (!this.snapshot || this.snapshot.length !== frame.positions.length) this.snapshot = new Float32Array(frame.positions.length);
    this.snapshot.set(frame.positions);
    this.onFrame(frame);
  }

  private fallback(): void {
    if (this.disposed || this.local) return;
    this.worker?.terminate();
    this.worker = null;
    this.mode = "main";
    this.local = createSimulationRuntime(
      (frame) => this.receive(frame),
      (step) => requestAnimationFrame(step),
      4,
    );
    if (this.replay) {
      // Pick up where the worker left off.
      const positions = this.snapshot ?? this.replay.positions;
      const alpha = this.snapshot ? 0.3 : this.replay.alpha;
      this.send({ type: "init", version: this.version, ...this.replay, positions: positions.slice(), alpha });
    }
  }
}
