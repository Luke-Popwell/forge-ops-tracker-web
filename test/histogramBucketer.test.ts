import { describe, expect, it } from "vitest";
import { BOUNDARIES_MS, bucketFor } from "../src/histogramBucketer.js";

describe("bucketFor", () => {
  it("returns the smallest boundary a duration fits under, as a string", () => {
    expect(bucketFor(10)).toBe("50");
    expect(bucketFor(50)).toBe("50");
    expect(bucketFor(51)).toBe("100");
    expect(bucketFor(4999)).toBe("5000");
  });

  it("returns inf for anything larger than the largest boundary", () => {
    expect(bucketFor(10001)).toBe("inf");
    expect(bucketFor(1000000)).toBe("inf");
  });

  it("puts a duration exactly on a boundary into that boundary's own bucket", () => {
    for (const boundary of BOUNDARIES_MS) {
      expect(bucketFor(boundary)).toBe(String(boundary));
    }
  });

  it("boundaries match the server's HistogramPercentile", () => {
    // app/services/histogram_percentile.rb and every other SDK must agree on this exact list.
    expect([...BOUNDARIES_MS]).toEqual([50, 100, 250, 500, 1000, 2500, 5000, 10000]);
  });
});
