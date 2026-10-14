import { createSimulationRuntime, type SimRequest } from "./simulation";

// Runs the layout off the main thread; positions go back as transferred Float32Arrays.
const handle = createSimulationRuntime(
  (frame, transfer) => self.postMessage(frame, { transfer }),
  (step) => setTimeout(step, 0),
);

self.addEventListener("message", (event: MessageEvent<SimRequest>) => handle(event.data));
