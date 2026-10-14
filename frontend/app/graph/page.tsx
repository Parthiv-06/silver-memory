import { GraphRoute } from "./graph-route";

export default function Page() {
  return (
    <main className="fixed inset-0 overflow-hidden overscroll-none bg-[#111113] text-[#ededf0]">
      <h1 className="sr-only">Knowledge graph</h1>
      <GraphRoute />
    </main>
  );
}
