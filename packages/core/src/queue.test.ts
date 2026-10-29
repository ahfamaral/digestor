import { describe, expect, it } from "vitest";
import { JOB_OPTIONS } from "./queue.ts";

describe("JOB_OPTIONS", () => {
  it("is the single source of queue and send options: retries, 12 h expiry and a 60 s heartbeat", () => {
    expect(JOB_OPTIONS).toEqual({ retryLimit: 2, retryDelay: 30, expireInSeconds: 43200, heartbeatSeconds: 60 });
  });
});
