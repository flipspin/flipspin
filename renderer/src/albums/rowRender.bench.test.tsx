import { DataProvider } from '../data';
import { render } from "@testing-library/react";
import { it, beforeAll, vi } from "vitest";
import type { ComponentType } from "react";
import { installFakeBackend } from "../data/test-support";
import UntypedRow from "./AlbumTrackRow";
const Row = UntypedRow as unknown as ComponentType<Record<string, unknown>>;
beforeAll(() => { HTMLElement.prototype.scrollIntoView = vi.fn(); });
const tracks = Array.from({ length: 714 }, (_, i) => ({ path: `/music/Album${i % 50}/song${i}.mp3`, relPath: `Album${i % 50}/song${i}.mp3`, title: `Song ${i}`, album: `Album${i % 50}`, duration: 200 }));
it.skipIf(!process.env.KROBI_BENCH)("bench 714 rows", async () => {
  const backend = installFakeBackend({ respond: () => ({ status: 200, json: {} }) });
  try {
    for (const round of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const t0 = performance.now();
      const r = render(<DataProvider><ul>{tracks.map((track, index) => <Row key={track.path} track={track} album={track.album} index={index} />)}</ul></DataProvider>);
      const t1 = performance.now();
      r.unmount();
      process.stderr.write(`BENCH round ${round}: ${Math.round(t1 - t0)} ms\n`);
    }
  } finally { backend.restore(); }
}, 120000);
